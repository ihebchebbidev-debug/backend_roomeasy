import { createHash, randomBytes } from "node:crypto";

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
  SELECT u.id, u.full_name, u.email, u.phone, u.verified, u.suspended, u.avatar_url,
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
  const row = await queryOne<AccountRow>(`${accountSelect} WHERE u.id = $1 ${accountGroupBy}`, [userId], {
    label: "accounts.findById",
  });
  return row ? mapAccount(row) : null;
}

export async function findAccountByEmail(email: string): Promise<AccountDto | null> {
  const row = await queryOne<AccountRow>(`${accountSelect} WHERE lower(u.email) = lower($1) ${accountGroupBy}`, [email], {
    label: "accounts.findByEmail",
  });
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
       VALUES ($1, $2, $3, $4, coalesce($5, 'en'), coalesce($6, 'USD'))
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
    `SELECT id, password_hash, suspended, suspended_reason FROM app_user WHERE lower(email) = lower($1)`,
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
