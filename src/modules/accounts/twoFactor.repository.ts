import { apiError } from "@/core/errors.js";
import { generateTotpSecret, verifyTotp } from "@/core/totp.js";
import { query, queryOne } from "@/db/query.js";

type Row = { two_factor_enabled: boolean; two_factor_secret: string | null; two_factor_pending_secret: string | null };

async function load(userId: string): Promise<Row> {
  const row = await queryOne<Row>(
    "SELECT two_factor_enabled, two_factor_secret, two_factor_pending_secret FROM app_user WHERE id = $1",
    [userId],
    { label: "twoFactor.load" },
  );
  if (!row) throw apiError("NOT_FOUND");
  return row;
}

/** Starts enrolment: a fresh secret is stored as pending until a code proves the app has it. */
export async function beginTwoFactorSetup(userId: string): Promise<string> {
  const secret = generateTotpSecret();
  await query("UPDATE app_user SET two_factor_pending_secret = $2 WHERE id = $1", [userId, secret], {
    label: "twoFactor.begin",
  });
  return secret;
}

export async function confirmTwoFactorSetup(userId: string, code: string): Promise<void> {
  const row = await load(userId);
  if (!row.two_factor_pending_secret) {
    throw apiError("VALIDATION_FAILED", { message: "Start the two-step setup again." });
  }
  if (!verifyTotp(row.two_factor_pending_secret, code)) throw apiError("TWO_FACTOR_INVALID");
  await query(
    `UPDATE app_user
        SET two_factor_secret = two_factor_pending_secret, two_factor_pending_secret = NULL, two_factor_enabled = true
      WHERE id = $1`,
    [userId],
    { label: "twoFactor.confirm" },
  );
}

export async function disableTwoFactor(userId: string, code: string): Promise<void> {
  const row = await load(userId);
  if (row.two_factor_enabled && row.two_factor_secret && !verifyTotp(row.two_factor_secret, code)) {
    throw apiError("TWO_FACTOR_INVALID");
  }
  await resetTwoFactor(userId);
}

/** Used by a super admin when a colleague lost their phone. */
export async function resetTwoFactor(userId: string): Promise<void> {
  await query(
    "UPDATE app_user SET two_factor_enabled = false, two_factor_secret = NULL, two_factor_pending_secret = NULL WHERE id = $1",
    [userId],
    { label: "twoFactor.reset" },
  );
}

/** Called at sign-in, after the password matched. */
export async function assertSecondFactor(userId: string, code: string | undefined): Promise<void> {
  const row = await load(userId);
  if (!row.two_factor_enabled || !row.two_factor_secret) return;
  if (!code) throw apiError("TWO_FACTOR_REQUIRED");
  if (!verifyTotp(row.two_factor_secret, code)) throw apiError("TWO_FACTOR_INVALID");
}
