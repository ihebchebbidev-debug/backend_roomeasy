import type { TableDef } from "@/db/registry/types.js";

/** Accounts, roles, host profiles, team members, consent, auth credentials. */
export const accountTables: TableDef[] = [
  {
    name: "app_user",
    comment: "One row per person: guests, hosts and admins.",
    primaryKey: ["id"],
    touchUpdatedAt: true,
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "legacy_id", type: "text", unique: true },
      { name: "full_name", type: "text", notNull: true },
      { name: "email", type: "text", notNull: true, unique: true, check: "position('@' IN email) > 1" },
      { name: "phone", type: "text" },
      {
        name: "password_hash",
        type: "text",
        note: "Added by the backend: db/schema.sql has no credential column, sign-in needs one.",
      },
      { name: "verified", type: "boolean", notNull: true, default: "false" },
      {
        name: "email_verified",
        type: "boolean",
        notNull: true,
        default: "false",
        note: "Separate from `verified` (identity check): confirms the signup address was proven via the emailed link.",
      },
      { name: "suspended", type: "boolean", notNull: true, default: "false" },
      { name: "suspended_reason", type: "text", note: "Shown to admins in the users tab." },
      {
        name: "suspended_until",
        type: "timestamptz",
        note: "End of a temporary suspension. NULL means the suspension is permanent until an admin lifts it.",
      },
      { name: "banned", type: "boolean", notNull: true, default: "false", note: "Hard ban: the account can never sign in again." },
      { name: "banned_reason", type: "text" },
      { name: "banned_at", type: "timestamptz" },
      { name: "avatar_url", type: "text" },
      { name: "locale", type: "text", notNull: true, default: "'en'" },
      { name: "currency", type: "text", notNull: true, default: "'EUR'" },
      { name: "two_factor_enabled", type: "boolean", notNull: true, default: "false" },
      { name: "two_factor_secret", type: "text", note: "Base32 TOTP secret, set once enrolment is confirmed." },
      { name: "two_factor_pending_secret", type: "text", note: "Secret awaiting its first valid code." },
      { name: "joined_on", type: "date", notNull: true, default: "CURRENT_DATE" },
      { name: "last_login_at", type: "timestamptz" },
      {
        name: "deleted_at",
        type: "timestamptz",
        note: "GDPR erasure: the row stays for accounting links but holds no personal data any more.",
      },
      { name: "deletion_reason", type: "text", note: "Optional reason given by the member when asking for erasure." },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "app_user_email_lower_idx", on: "lower(email)" }],
  },

  {
    name: "user_role_grant",
    comment: "Roles never live on the profile row — privilege escalation risk.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "role", type: "user_role", notNull: true },
      { name: "granted_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    constraints: [{ name: "user_role_grant_unique", definition: "UNIQUE (user_id, role)" }],
    indexes: [{ name: "user_role_grant_user_idx", on: "user_id" }],
  },

  {
    name: "user_avatar",
    comment: "The current processed profile photo for an account.",
    primaryKey: ["user_id"],
    touchUpdatedAt: true,
    columns: [
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "content", type: "bytea", notNull: true },
      { name: "content_type", type: "text", notNull: true, check: "content_type IN ('image/jpeg', 'image/png', 'image/webp')" },
      { name: "byte_size", type: "integer", notNull: true, check: "byte_size > 0 AND byte_size <= 2097152" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "password_reset_token",
    comment: "Backend addition: powers the forgot-password screen.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "token_hash", type: "text", notNull: true, unique: true },
      { name: "expires_at", type: "timestamptz", notNull: true },
      { name: "used_at", type: "timestamptz" },
      { name: "requested_ip", type: "text" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "password_reset_user_idx", on: "user_id, created_at DESC" }],
  },

  {
    name: "email_verification_token",
    comment: "Backend addition: powers the signup email confirmation link.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "token_hash", type: "text", notNull: true, unique: true },
      { name: "expires_at", type: "timestamptz", notNull: true },
      { name: "used_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "email_verification_user_idx", on: "user_id, created_at DESC" }],
  },

  {
    name: "host_profile",
    primaryKey: ["user_id"],
    touchUpdatedAt: true,
    columns: [
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "display_name", type: "text", notNull: true },
      {
        name: "hosting_since",
        type: "integer",
        notNull: true,
        default: "date_part('year', now())::int",
        check: "hosting_since BETWEEN 1990 AND 2100",
      },
      { name: "superhost", type: "boolean", notNull: true, default: "false" },
      { name: "bio", type: "text" },
      { name: "response_rate", type: "numeric(5,2)", check: "response_rate BETWEEN 0 AND 100" },
      { name: "payouts_onboarded", type: "boolean", notNull: true, default: "false" },
      { name: "payout_reference", type: "text" },
      { name: "stripe_account_id", type: "text" },
      { name: "stripe_charges_enabled", type: "boolean", notNull: true, default: "false" },
      { name: "stripe_payouts_enabled", type: "boolean", notNull: true, default: "false" },
      { name: "stripe_details_submitted", type: "boolean", notNull: true, default: "false" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "host_team_member",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "text", notNull: true },
      { name: "host_id", type: "uuid", notNull: true, references: "host_profile(user_id) ON DELETE CASCADE" },
      { name: "full_name", type: "text", notNull: true },
      { name: "email", type: "text", notNull: true },
      { name: "scopes", type: "team_scope[]", notNull: true, default: "'{}'" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    constraints: [{ name: "host_team_member_email_unique", definition: "UNIQUE (host_id, email)" }],
    indexes: [{ name: "host_team_member_host_idx", on: "host_id" }],
  },

  {
    name: "cookie_consent",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "user_id", type: "uuid", references: "app_user(id) ON DELETE CASCADE" },
      { name: "device_id", type: "text" },
      { name: "choice", type: "cookie_choice", notNull: true },
      { name: "decided_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    constraints: [
      { name: "cookie_consent_subject", definition: "CHECK (user_id IS NOT NULL OR device_id IS NOT NULL)" },
    ],
  },

  {
    name: "favorite",
    primaryKey: ["user_id", "property_id"],
    columns: [
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "property_id", type: "text", notNull: true, references: "property(id) ON DELETE CASCADE" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "favorite_property_idx", on: "property_id" }],
  },
];
