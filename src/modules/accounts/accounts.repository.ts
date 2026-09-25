import { createHash, randomBytes, randomInt } from "node:crypto";

import bcrypt from "bcryptjs";

import { env } from "@/config/env.js";
import { apiError } from "@/core/errors.js";
import { query, queryOne, transaction } from "@/db/query.js";
import type { Role } from "@/middleware/auth.js";

/** Public account shape returned to the app (never contains the password hash). */
export type AccountDto = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  verified: boolean;
  emailVerified: boolean;
  suspended: boolean;
  avatarUrl: string | null;
  locale: string;
  currency: string;
  twoFactorEnabled: boolean;
  roles: Role[];
  joinedOn: string;
  lastLoginAt: string | null;
  host: {
    displayName: string;
    hostingSince: number;
    superhost: boolean;
    bio: string | null;
    responseRate: number | null;
    payoutsOnboarded: boolean;
  } | null;
};

type AccountRow = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  verified: boolean;
  email_verified: boolean;
  suspended: boolean;
  avatar_url: string | null;
  locale: string;
  currency: string;
  two_factor_enabled: boolean;
  roles: Role[] | null;
  joined_on: Date | string;
  last_login_at: Date | null;
  host_display_name: string | null;
  hosting_since: number | null;
  superhost: boolean | null;
  bio: string | null;
  response_rate: string | null;
  payouts_onboarded: boolean | null;
};

const accountSelect = `
  SELECT u.id, u.full_name, u.email, u.phone, u.verified, u.email_verified, u.suspended, u.avatar_url,
         u.locale, u.currency, u.two_factor_enabled, u.joined_on, u.last_login_at,
         coalesce(array_agg(DISTINCT g.role) FILTER (WHERE g.role IS NOT NULL), '{}')::text[] AS roles,
         h.display_name AS host_display_name, h.hosting_since, h.superhost, h.bio,
         h.response_rate, h.payouts_onboarded
    FROM app_user u
    LEFT JOIN user_role_grant g ON g.user_id = u.id
    LEFT JOIN host_profile h    ON h.user_id = u.id
`;

const accountGroupBy = ` GROUP BY u.id, h.user_id`;

export function mapAccount(row: AccountRow): AccountDto {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    verified: row.verified,
    emailVerified: row.email_verified,
    suspended: row.suspended,
    avatarUrl: row.avatar_url,
    locale: row.locale,
    currency: row.currency,
    twoFactorEnabled: row.two_factor_enabled,
    roles: (row.roles?.length ? row.roles : ["guest"]) as Role[],
    joinedOn: typeof row.joined_on === "string" ? row.joined_on : row.joined_on.toISOString().slice(0, 10),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
    host: row.host_display_name
      ? {
          displayName: row.host_display_name,
          hostingSince: row.hosting_since ?? new Date().getUTCFullYear(),
          superhost: row.superhost ?? false,
          bio: row.bio,
          responseRate: row.response_rate === null ? null : Number(row.response_rate),
          payoutsOnboarded: row.payouts_onboarded ?? false,
        }
      : null,
  };
}

export async function findAccountById(userId: string): Promise<AccountDto | null> {
  const row = await queryOne<AccountRow>(
    `${accountSelect} WHERE u.id = $1 AND u.deleted_at IS NULL ${accountGroupBy}`,
    [userId],
    { label: "accounts.findById" },
  );
  return row ? mapAccount(row) : null;
}

export async function findAccountByEmail(email: string): Promise<AccountDto | null> {
  const row = await queryOne<AccountRow>(
    `${accountSelect} WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL ${accountGroupBy}`,
    [email],
    { label: "accounts.findByEmail" },
  );
  return row ? mapAccount(row) : null;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

/**
 * Creates the account, grants the requested roles and (for hosts) the public
 * host profile — all inside one transaction so a half-created account can
 * never exist.
 */
export async function createAccount(input: {
  fullName: string;
  email: string;
  password: string;
  phone?: string | null;
  locale?: string;
  currency?: string;
  roles?: Role[];
}): Promise<AccountDto> {
  const roles: Role[] = input.roles?.length ? input.roles : ["guest"];
  const passwordHash = await hashPassword(input.password);

  const existing = await queryOne<{ id: string }>(`SELECT id FROM app_user WHERE lower(email) = lower($1)`, [
    input.email,
  ]);
  if (existing) throw apiError("EMAIL_TAKEN", { details: { email: input.email } });

  const userId = await transaction(async (client) => {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO app_user (full_name, email, phone, password_hash, locale, currency)
       VALUES ($1, $2, $3, $4, coalesce($5, 'en'), coalesce($6, 'EUR'))
       RETURNING id`,
      [input.fullName, input.email, input.phone ?? null, passwordHash, input.locale ?? null, input.currency ?? null],
      { client, label: "accounts.insert" },
    );

    const id = created!.id;

    await query(
      `INSERT INTO user_role_grant (user_id, role)
       SELECT $1, role::user_role FROM unnest($2::text[]) AS r(role)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [id, roles],
      { client, label: "accounts.grantRoles" },
    );

    if (roles.includes("host")) {
      await query(
        `INSERT INTO host_profile (user_id, display_name)
         VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
        [id, input.fullName],
        { client, label: "accounts.createHostProfile" },
      );
    }

    return id;
  }, "accounts.create");

  const account = await findAccountById(userId);
  if (!account) throw apiError("INTERNAL", { message: "The account was created but could not be read back." });
  return account;
}

/** Verifies the credentials and returns the account, or throws a typed error. */
export async function verifyCredentials(email: string, plainPassword: string): Promise<AccountDto> {
  const row = await queryOne<{ id: string; password_hash: string | null; suspended: boolean; suspended_reason: string | null }>(
    `SELECT id, password_hash, suspended, suspended_reason FROM app_user
      WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
    { label: "accounts.verifyCredentials" },
  );

  // Same error for "no such account" and "wrong password": never leak which
  // email addresses exist.
  if (!row?.password_hash) throw apiError("INVALID_CREDENTIALS");

  const matches = await bcrypt.compare(plainPassword, row.password_hash);
  if (!matches) throw apiError("INVALID_CREDENTIALS");

  if (row.suspended) {
    throw apiError("ACCOUNT_SUSPENDED", {
      message: row.suspended_reason
        ? `This account has been suspended: ${row.suspended_reason}`
        : "This account has been suspended by an administrator.",
    });
  }

  await query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [row.id], { label: "accounts.touchLogin" });

  const account = await findAccountById(row.id);
  if (!account) throw apiError("INTERNAL", { message: "The account could not be loaded after sign-in." });
  return account;
}

export async function updateProfile(
  userId: string,
  patch: {
    fullName?: string;
    phone?: string | null;
    avatarUrl?: string | null;
    locale?: string;
    currency?: string;
    twoFactorEnabled?: boolean;
  },
): Promise<AccountDto> {
  await query(
    `UPDATE app_user SET
       full_name          = coalesce($2, full_name),
       phone              = coalesce($3, phone),
       avatar_url         = coalesce($4, avatar_url),
       locale             = coalesce($5, locale),
       currency           = coalesce($6, currency),
       two_factor_enabled = coalesce($7, two_factor_enabled)
     WHERE id = $1`,
    [
      userId,
      patch.fullName ?? null,
      patch.phone ?? null,
      patch.avatarUrl ?? null,
      patch.locale ?? null,
      patch.currency ?? null,
      patch.twoFactorEnabled ?? null,
    ],
    { label: "accounts.updateProfile" },
  );

  const account = await findAccountById(userId);
  if (!account) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
  return account;
}

export type AvatarFile = { content: Buffer; contentType: "image/jpeg" | "image/png" | "image/webp"; updatedAt: Date };

export async function saveAvatar(userId: string, file: Omit<AvatarFile, "updatedAt">): Promise<AccountDto> {
  await transaction(async (client) => {
    await query(
      `INSERT INTO user_avatar (user_id, content, content_type, byte_size)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         content = excluded.content, content_type = excluded.content_type,
         byte_size = excluded.byte_size, updated_at = now()`,
      [userId, file.content, file.contentType, file.content.length],
      { client, label: "accounts.saveAvatar" },
    );
    await query(`UPDATE app_user SET avatar_url = $2 WHERE id = $1`, [userId, `/api/accounts/${userId}/avatar`], {
      client,
      label: "accounts.linkAvatar",
    });
  }, "accounts.saveAvatar");
  const account = await findAccountById(userId);
  if (!account) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
  return account;
}

export async function removeAvatar(userId: string): Promise<AccountDto> {
  await transaction(async (client) => {
    await query(`DELETE FROM user_avatar WHERE user_id = $1`, [userId], { client, label: "accounts.deleteAvatar" });
    await query(`UPDATE app_user SET avatar_url = NULL WHERE id = $1`, [userId], { client, label: "accounts.unlinkAvatar" });
  }, "accounts.removeAvatar");
  const account = await findAccountById(userId);
  if (!account) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
  return account;
}

export async function findAvatar(userId: string): Promise<AvatarFile | null> {
  return queryOne<AvatarFile>(
    `SELECT content, content_type AS "contentType", updated_at AS "updatedAt" FROM user_avatar WHERE user_id = $1`,
    [userId],
    { label: "accounts.findAvatar" },
  );
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<void> {
  const row = await queryOne<{ password_hash: string | null }>(`SELECT password_hash FROM app_user WHERE id = $1`, [
    userId,
  ]);
  if (!row) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
  if (!row.password_hash) throw apiError("INVALID_CREDENTIALS", { message: "This account has no password set." });

  const matches = await bcrypt.compare(currentPassword, row.password_hash);
  if (!matches) {
    throw apiError("INVALID_CREDENTIALS", {
      message: "The current password is incorrect.",
      issues: [{ field: "currentPassword", message: "The current password is incorrect." }],
    });
  }

  await query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`, [userId, await hashPassword(nextPassword)], {
    label: "accounts.changePassword",
  });
}

/** Grants a role once; used by "become a host" and by the admin panel. */
export async function grantRole(userId: string, role: Role, displayName?: string): Promise<AccountDto> {
  await transaction(async (client) => {
    await query(
      `INSERT INTO user_role_grant (user_id, role) VALUES ($1, $2::user_role)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId, role],
      { client, label: "accounts.grantRole" },
    );

    if (role === "host") {
      await query(
        `INSERT INTO host_profile (user_id, display_name)
         VALUES ($1, coalesce($2, (SELECT full_name FROM app_user WHERE id = $1)))
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, displayName ?? null],
        { client, label: "accounts.ensureHostProfile" },
      );
    }
  }, "accounts.grantRole");

  const account = await findAccountById(userId);
  if (!account) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
  return account;
}

/**
 * Files the identity document supplied when a member becomes a host. It is
 * stored as a pending check so an administrator can verify or reject it; an
 * already verified member keeps their status.
 */
export async function submitIdentityDocument(input: {
  userId: string;
  documentKind: string;
  documentReference: string;
  documentFiles?: string[];
}): Promise<void> {
  await query(
    `INSERT INTO identity_verification (user_id, status, document_kind, document_reference, document_files)
     VALUES ($1, 'pending', $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
        SET document_kind = $2,
            document_reference = $3,
            document_files = coalesce($4, identity_verification.document_files),
            status = CASE WHEN identity_verification.status = 'verified'
                          THEN identity_verification.status
                          ELSE 'pending'::verification_status END`,
    [input.userId, input.documentKind, input.documentReference, input.documentFiles?.length ? input.documentFiles : null],
    { label: "accounts.submitIdentityDocument" },
  );
}

export async function revokeRole(userId: string, role: Role): Promise<void> {
  if (role === "guest") {
    throw apiError("CONFLICT", { message: "The guest role cannot be removed from an account." });
  }
  await query(`DELETE FROM user_role_grant WHERE user_id = $1 AND role = $2::user_role`, [userId, role], {
    label: "accounts.revokeRole",
  });
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A 4-digit code is only safe when it is scoped to one account. */
function hashCode(userId: string, code: string): string {
  return hashToken(`${userId}:${code}`);
}


/**
 * Creates a single-use reset token. The plain token is returned so the caller
 * can email it; only its hash is stored.
 */
export async function createPasswordResetToken(
  email: string,
  requestedIp: string | null,
): Promise<{ token: string; expiresAt: string } | null> {
  const row = await queryOne<{ id: string }>(`SELECT id FROM app_user WHERE lower(email) = lower($1)`, [email]);
  // Unknown address: return null and let the route answer "email sent" anyway.
  if (!row) return null;

  const token = randomBytes(32).toString("base64url");
  const created = await queryOne<{ expires_at: Date }>(
    `INSERT INTO password_reset_token (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, now() + interval '1 hour', $3)
     RETURNING expires_at`,
    [row.id, hashToken(token), requestedIp],
    { label: "accounts.createResetToken" },
  );

  return { token, expiresAt: created!.expires_at.toISOString() };
}

export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM password_reset_token
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
    { label: "accounts.findResetToken" },
  );
  if (!row) throw apiError("RESET_TOKEN_INVALID");

  await transaction(async (client) => {
    await query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`, [row.user_id, await hashPassword(newPassword)], {
      client,
      label: "accounts.applyReset",
    });
    await query(`UPDATE password_reset_token SET used_at = now() WHERE id = $1`, [row.id], {
      client,
      label: "accounts.consumeResetToken",
    });
  }, "accounts.resetPassword");
}

/**
 * Issues a 4-digit confirmation code for the forgot-password screen. Any code
 * still pending for the account is retired first, only the hash is stored, and
 * the code lives for 15 minutes.
 */
export async function createPasswordResetCode(
  email: string,
  requestedIp: string | null,
): Promise<{ code: string; expiresAt: string; fullName: string; locale: string } | null> {
  const row = await queryOne<{ id: string; full_name: string; locale: string }>(
    `SELECT id, full_name, locale FROM app_user WHERE lower(email) = lower($1)`,
    [email],
    { label: "accounts.findResetRecipient" },
  );
  // Unknown address: return null and let the route answer "code sent" anyway.
  if (!row) return null;

  await query(`UPDATE password_reset_token SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.id], {
    label: "accounts.retireResetCodes",
  });

  const code = String(randomInt(1000, 10000));
  const created = await queryOne<{ expires_at: Date }>(
    `INSERT INTO password_reset_token (user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, now() + interval '15 minutes', $3)
     RETURNING expires_at`,
    [row.id, hashCode(row.id, code), requestedIp],
    { label: "accounts.createResetCode" },
  );

  return { code, expiresAt: created!.expires_at.toISOString(), fullName: row.full_name, locale: row.locale };
}

/**
 * Trades a correct 4-digit code for a single-use ticket. The ticket is what the
 * "choose a new password" step sends back, so the code never travels twice.
 */
export async function exchangeResetCodeForTicket(
  email: string,
  code: string,
): Promise<{ token: string; expiresAt: string }> {
  const user = await queryOne<{ id: string }>(`SELECT id FROM app_user WHERE lower(email) = lower($1)`, [email], {
    label: "accounts.findResetUser",
  });
  if (!user) throw apiError("RESET_TOKEN_INVALID");

  const ticket = randomBytes(32).toString("base64url");
  const updated = await queryOne<{ expires_at: Date }>(
    `UPDATE password_reset_token
        SET token_hash = $3, expires_at = now() + interval '15 minutes'
      WHERE id = (
        SELECT id FROM password_reset_token
         WHERE user_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1
      )
      RETURNING expires_at`,
    [user.id, hashCode(user.id, code), hashToken(ticket)],
    { label: "accounts.exchangeResetCode" },
  );
  if (!updated) throw apiError("RESET_TOKEN_INVALID");

  return { token: ticket, expiresAt: updated.expires_at.toISOString() };
}

// ---------------------------------------------------------------------------
// Cookie consent
// ---------------------------------------------------------------------------

export async function recordCookieConsent(input: {
  userId: string | null;
  deviceId: string | null;
  choice: "accepted" | "essential";
}): Promise<void> {
  if (!input.userId && !input.deviceId) {
    throw apiError("VALIDATION_FAILED", { message: "Send either a signed-in user or a deviceId." });
  }
  await query(
    `INSERT INTO cookie_consent (user_id, device_id, choice) VALUES ($1, $2, $3::cookie_choice)`,
    [input.userId, input.deviceId, input.choice],
    { label: "accounts.cookieConsent" },
  );
}

// ---------------------------------------------------------------------------
// Trust badges ("Genuse")
// ---------------------------------------------------------------------------

export async function trustBadgesFor(userId: string) {
  const rows = await query<{
    code: string;
    qualifying_reservations: string;
    min_reservations: number;
    eligible: boolean;
    awarded_at: Date | null;
  }>(
    `SELECT e.code, e.qualifying_reservations, e.min_reservations, e.eligible, a.awarded_at
       FROM trust_badge_eligibility e
       LEFT JOIN trust_badge_award a ON a.user_id = e.user_id AND a.code = e.code
      WHERE e.user_id = $1`,
    [userId],
    { label: "accounts.trustBadges" },
  );

  return rows.map((row) => ({
    code: row.code,
    reservations: Number(row.qualifying_reservations),
    required: row.min_reservations,
    eligible: row.eligible,
    awardedAt: row.awarded_at ? row.awarded_at.toISOString() : null,
  }));
}

/** Awards every badge the user is now eligible for. Safe to call repeatedly. */
export async function syncTrustBadges(userId: string): Promise<void> {
  await query(
    `INSERT INTO trust_badge_award (user_id, code)
     SELECT user_id, code FROM trust_badge_eligibility WHERE user_id = $1 AND eligible
     ON CONFLICT (user_id, code) DO NOTHING`,
    [userId],
    { label: "accounts.syncTrustBadges" },
  );
}

/**
 * Sets a password without knowing the previous one. Only the development-only
 * admin bootstrap route uses it, so the account can be reused between tests.
 */
export async function resetPasswordForDev(userId: string, nextPassword: string): Promise<void> {
  await query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`, [userId, await hashPassword(nextPassword)], {
    label: "accounts.resetPasswordForDev",
  });
}

/**
 * GDPR erasure (right to be forgotten).
 *
 * The account row itself is kept — bookings, payments and invoices must stay
 * linked for accounting — but every piece of personal data is removed and the
 * account can never be used again. Password confirmation is mandatory, and the
 * request is refused while the member still has live obligations.
 */
export async function deleteOwnAccount(input: {
  userId: string;
  password: string;
  reason?: string | null;
}): Promise<{ deletedAt: string }> {
  const row = await queryOne<{ id: string; email: string; full_name: string; password_hash: string | null; deleted_at: Date | null }>(
    `SELECT id, email, full_name, password_hash, deleted_at FROM app_user WHERE id = $1`,
    [input.userId],
    { label: "accounts.deleteOwn.load" },
  );
  if (!row || row.deleted_at) throw apiError("NOT_FOUND", { message: "This account no longer exists." });
  if (!row.password_hash) throw apiError("INVALID_CREDENTIALS", { message: "This account has no password set." });

  const matches = await bcrypt.compare(input.password, row.password_hash);
  if (!matches) {
    throw apiError("INVALID_CREDENTIALS", {
      message: "The password is incorrect.",
      issues: [{ field: "password", message: "The password is incorrect." }],
    });
  }

  // Live obligations block the erasure: a stay still to come, or money still
  // owed to the host.
  const blockers = await queryOne<{ stays: string; payouts: string }>(
    `SELECT
       (SELECT count(*) FROM booking b
          LEFT JOIN property p ON p.id = b.property_id
         WHERE b.status IN ('pending', 'confirmed')
           AND b.check_out >= current_date
           AND (b.guest_id = $1 OR p.host_id = $1)) AS stays,
       (SELECT count(*) FROM payout WHERE host_id = $1 AND status = 'scheduled') AS payouts`,
    [input.userId],
    { label: "accounts.deleteOwn.blockers" },
  );
  if (Number(blockers?.stays ?? 0) > 0) {
    throw apiError("CONFLICT", {
      message:
        "You still have a stay in progress or coming up. Once every booking is finished or cancelled, you can delete your account.",
    });
  }
  if (Number(blockers?.payouts ?? 0) > 0) {
    throw apiError("CONFLICT", {
      message: "A payout is still on its way to you. You can delete your account once it has been sent.",
    });
  }

  const deletedAt = await transaction(async (client) => {
    const placeholder = `deleted-${row.id}@deleted.invalid`;

    // Anything that only exists to serve this person goes.
    await query(`DELETE FROM user_avatar WHERE user_id = $1`, [row.id], { client, label: "accounts.deleteOwn.avatar" });
    await query(`DELETE FROM favorite WHERE user_id = $1`, [row.id], { client, label: "accounts.deleteOwn.favorites" });
    await query(`DELETE FROM cookie_consent WHERE user_id = $1`, [row.id], { client, label: "accounts.deleteOwn.consent" });
    await query(`DELETE FROM user_role_grant WHERE user_id = $1`, [row.id], { client, label: "accounts.deleteOwn.roles" });
    await query(`DELETE FROM host_team_member WHERE host_id = $1`, [row.id], { client, label: "accounts.deleteOwn.team" });

    // A host leaving takes their listings offline.
    await query(
      `UPDATE listing SET status = 'suspended'
        WHERE property_id IN (SELECT id FROM property WHERE host_id = $1)`,
      [row.id],
      { client, label: "accounts.deleteOwn.unpublish" },
    );

    // Historic records keep their row, lose the personal details.
    await query(
      `UPDATE booking SET guest_name = 'Deleted account', guest_email = NULL, guest_phone = NULL, message = NULL
        WHERE guest_id = $1`,
      [row.id],
      { client, label: "accounts.deleteOwn.bookings" },
    );
    await query(`UPDATE review SET author_name = 'Deleted account' WHERE author_id = $1`, [row.id], {
      client,
      label: "accounts.deleteOwn.reviews",
    });

    const updated = await queryOne<{ deleted_at: Date }>(
      `UPDATE app_user SET
         deleted_at         = now(),
         deletion_reason    = $2,
         full_name          = 'Deleted account',
         email              = $3,
         phone              = NULL,
         password_hash      = NULL,
         avatar_url         = NULL,
         two_factor_enabled = false,
         verified           = false,
         suspended          = true,
         suspended_reason   = 'Account deleted at the member''s request'
       WHERE id = $1
       RETURNING deleted_at`,
      [row.id, input.reason ?? null, placeholder],
      { client, label: "accounts.deleteOwn.anonymise" },
    );

    // Audit trail for the back office (no personal data beyond the account id).
    await query(
      `INSERT INTO moderation_log (admin_id, action, target_kind, target_id, reason)
       VALUES (NULL, 'account_deleted', 'user', $1, $2)`,
      [row.id, input.reason ?? "Erasure requested by the member"],
      { client, label: "accounts.deleteOwn.audit" },
    );

    return updated?.deleted_at ?? new Date();
  }, "accounts.deleteOwnAccount");

  return { deletedAt: deletedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Email verification (signup address confirmation — separate from identity)
// ---------------------------------------------------------------------------

/**
 * Issues a single-use, expiring token and returns the plain value so the
 * caller can email it; only its hash is stored, mirroring the password reset
 * design above.
 */
export async function createEmailVerificationToken(
  userId: string,
): Promise<{ token: string; expiresAt: string } | null> {
  const user = await queryOne<{ email_verified: boolean }>(
    `SELECT email_verified FROM app_user WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
    { label: "accounts.findForVerification" },
  );
  if (!user || user.email_verified) return null;

  const token = randomBytes(32).toString("base64url");
  const created = await queryOne<{ expires_at: Date }>(
    `INSERT INTO email_verification_token (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '48 hours')
     RETURNING expires_at`,
    [userId, hashToken(token)],
    { label: "accounts.createEmailVerificationToken" },
  );

  return { token, expiresAt: created!.expires_at.toISOString() };
}

export async function verifyEmailWithToken(token: string): Promise<void> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM email_verification_token
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
    { label: "accounts.findVerificationToken" },
  );
  if (!row) throw apiError("VERIFICATION_TOKEN_INVALID", { message: "This verification link is invalid or has expired." });

  await transaction(async (client) => {
    await query(`UPDATE app_user SET email_verified = true WHERE id = $1`, [row.user_id], {
      client,
      label: "accounts.applyEmailVerification",
    });
    await query(`UPDATE email_verification_token SET used_at = now() WHERE id = $1`, [row.id], {
      client,
      label: "accounts.consumeVerificationToken",
    });
  }, "accounts.verifyEmail");
}

/** Used by the resend endpoint; returns null when the account is unknown or already verified so the route stays neutral. */
export async function createEmailVerificationTokenForEmail(
  email: string,
): Promise<{ token: string; expiresAt: string; userId: string; fullName: string; locale: string } | null> {
  const row = await queryOne<{ id: string; full_name: string; locale: string; email_verified: boolean }>(
    `SELECT id, full_name, locale, email_verified FROM app_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email],
    { label: "accounts.findForResendVerification" },
  );
  if (!row || row.email_verified) return null;
  const issued = await createEmailVerificationToken(row.id);
  if (!issued) return null;
  return { ...issued, userId: row.id, fullName: row.full_name, locale: row.locale };
}
