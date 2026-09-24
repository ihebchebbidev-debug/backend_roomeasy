import type { TableDef } from "@/db/registry/types.js";

/** Settings, analytics, FX rates, trusted-guest badges and the migration log. */
export const platformTables: TableDef[] = [
  {
    name: "platform_settings",
    comment: "Single row (id = true) holding the global fee and rate configuration.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "boolean", notNull: true, default: "true", check: "id" },
      {
        name: "service_fee_rate",
        type: "numeric(5,4)",
        notNull: true,
        default: "0.08",
        check: "service_fee_rate BETWEEN 0 AND 1",
      },
      { name: "tax_rate", type: "numeric(5,4)", notNull: true, default: "0.05", check: "tax_rate BETWEEN 0 AND 1" },
      {
        name: "commission_rate",
        type: "numeric(5,2)",
        notNull: true,
        default: "12",
        check: "commission_rate BETWEEN 0 AND 100",
      },
      { name: "rate_weekend_percent", type: "numeric(5,2)", notNull: true, default: "15" },
      { name: "rate_long_stay_percent", type: "numeric(5,2)", notNull: true, default: "10" },
      { name: "rate_last_minute_percent", type: "numeric(5,2)", notNull: true, default: "5" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "integration_setting",
    comment: "Email (SMTP) and Stripe credentials editable from the back office. Overrides the .env values.",
    primaryKey: ["key"],
    columns: [
      { name: "key", type: "text", notNull: true },
      { name: "value", type: "text", notNull: true, default: "''" },
      { name: "updated_by", type: "uuid" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "host_rate_rules",
    primaryKey: ["host_id"],
    columns: [
      { name: "host_id", type: "uuid", notNull: true, references: "host_profile(user_id) ON DELETE CASCADE" },
      { name: "weekend_percent", type: "numeric(5,2)", notNull: true, default: "15" },
      { name: "long_stay_percent", type: "numeric(5,2)", notNull: true, default: "10" },
      { name: "last_minute_percent", type: "numeric(5,2)", notNull: true, default: "5" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "booking_monthly_stat",
    comment: "Dashboard chart source; refreshed from bookings by the analytics service.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "host_id", type: "uuid", references: "host_profile(user_id) ON DELETE CASCADE" },
      { name: "year", type: "integer", notNull: true, check: "year BETWEEN 2000 AND 2100" },
      { name: "month", type: "integer", notNull: true, check: "month BETWEEN 1 AND 12" },
      { name: "bookings", type: "integer", notNull: true, default: "0", check: "bookings >= 0" },
      { name: "revenue_usd", type: "numeric(12,2)", notNull: true, default: "0", check: "revenue_usd >= 0" },
    ],
    constraints: [{ name: "booking_monthly_stat_unique", definition: "UNIQUE (host_id, year, month)" }],
  },

  {
    name: "exchange_rate",
    primaryKey: ["base_currency", "quote_currency"],
    columns: [
      { name: "base_currency", type: "char(3)", notNull: true, default: "'USD'" },
      { name: "quote_currency", type: "char(3)", notNull: true },
      { name: "rate", type: "numeric(18,8)", notNull: true, check: "rate > 0" },
      { name: "fetched_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "trust_badge_rule",
    comment: "'Genuse' trusted-guest criteria (provisional: 5 stays / 24 months).",
    primaryKey: ["code"],
    columns: [
      { name: "code", type: "text", notNull: true },
      { name: "min_reservations", type: "integer", notNull: true, default: "5", check: "min_reservations > 0" },
      { name: "window_months", type: "integer", notNull: true, default: "24", check: "window_months > 0" },
      { name: "requires_verified_account", type: "boolean", notNull: true, default: "true" },
      { name: "active", type: "boolean", notNull: true, default: "true" },
      { name: "notes", type: "text" },
    ],
  },

  {
    name: "trust_badge_award",
    primaryKey: ["user_id", "code"],
    columns: [
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "code", type: "text", notNull: true, references: "trust_badge_rule(code) ON DELETE CASCADE" },
      { name: "awarded_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "expires_at", type: "timestamptz" },
    ],
  },

  {
    name: "schema_migration_log",
    comment: "Written by the auto-migrator: one row per reconciliation run.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "trigger_source", type: "text", notNull: true },
      { name: "statements", type: "integer", notNull: true, default: "0" },
      { name: "applied", type: "jsonb", notNull: true, default: "'[]'::jsonb" },
      { name: "duration_ms", type: "integer", notNull: true, default: "0" },
      { name: "succeeded", type: "boolean", notNull: true, default: "true" },
      { name: "error_message", type: "text" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "schema_migration_log_created_idx", on: "created_at DESC" }],
  },
];
