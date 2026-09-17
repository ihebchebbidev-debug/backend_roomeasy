import type { TableDef } from "@/db/registry/types.js";

/**
 * Back-office tables required by the administrator specification:
 * listing reports, support tickets and disputes, per-host commission,
 * manual refunds, identity verification and the outgoing notification queue.
 */
export const adminTables: TableDef[] = [
  {
    name: "listing_report",
    comment: "Guest/host reports about a listing; queued for a moderator.",
    primaryKey: ["id"],
    touchUpdatedAt: true,
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "listing_id", type: "text", notNull: true, references: "listing(id) ON DELETE CASCADE" },
      { name: "reported_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "reporter_name", type: "text" },
      { name: "reason", type: "report_reason", notNull: true, default: "'other'" },
      { name: "details", type: "text", check: "details IS NULL OR char_length(details) <= 2000" },
      { name: "status", type: "report_status", notNull: true, default: "'open'" },
      { name: "resolution", type: "text" },
      { name: "handled_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "handled_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "listing_report_status_idx", on: "status, created_at DESC" },
      { name: "listing_report_listing_idx", on: "listing_id" },
    ],
  },

  {
    name: "support_ticket",
    comment: "Support requests and guest/host disputes handled by the support desk.",
    primaryKey: ["id"],
    touchUpdatedAt: true,
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "reference", type: "text", notNull: true, unique: true },
      { name: "subject", type: "text", notNull: true, check: "char_length(subject) BETWEEN 3 AND 200" },
      { name: "category", type: "ticket_category", notNull: true, default: "'other'" },
      { name: "priority", type: "ticket_priority", notNull: true, default: "'normal'" },
      { name: "status", type: "ticket_status", notNull: true, default: "'open'" },
      { name: "opened_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "opened_by_name", type: "text", notNull: true, default: "''" },
      { name: "opened_by_role", type: "actor_role", notNull: true, default: "'guest'" },
      { name: "booking_id", type: "text", references: "booking(id) ON DELETE SET NULL" },
      { name: "listing_id", type: "text", references: "listing(id) ON DELETE SET NULL" },
      { name: "assigned_to", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "resolution", type: "text" },
      { name: "closed_at", type: "timestamptz" },
      { name: "last_activity_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "support_ticket_status_idx", on: "status, last_activity_at DESC" },
      { name: "support_ticket_opener_idx", on: "opened_by" },
      { name: "support_ticket_assignee_idx", on: "assigned_to" },
    ],
  },

  {
    name: "support_ticket_message",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "ticket_id", type: "uuid", notNull: true, references: "support_ticket(id) ON DELETE CASCADE" },
      { name: "author_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "author_name", type: "text", notNull: true, default: "''" },
      { name: "author_role", type: "actor_role", notNull: true, default: "'admin'" },
      { name: "body", type: "text", notNull: true, check: "char_length(body) BETWEEN 1 AND 4000" },
      { name: "internal_note", type: "boolean", notNull: true, default: "false" },
      { name: "sent_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "support_ticket_message_idx", on: "ticket_id, sent_at" }],
  },

  {
    name: "host_commission",
    comment: "Per-host commission rate; overrides platform_settings.commission_rate.",
    primaryKey: ["host_id"],
    touchUpdatedAt: true,
    columns: [
      { name: "host_id", type: "uuid", notNull: true, references: "host_profile(user_id) ON DELETE CASCADE" },
      {
        name: "commission_rate",
        type: "numeric(5,2)",
        notNull: true,
        check: "commission_rate BETWEEN 0 AND 100",
      },
      { name: "note", type: "text" },
      { name: "set_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "booking_refund",
    comment: "Manual full or partial refunds issued from the back office.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "booking_id", type: "text", notNull: true, references: "booking(id) ON DELETE CASCADE" },
      { name: "amount_usd", type: "numeric(12,2)", notNull: true, check: "amount_usd > 0" },
      { name: "reason", type: "text", notNull: true, check: "char_length(reason) BETWEEN 3 AND 600" },
      { name: "issued_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "booking_refund_booking_idx", on: "booking_id, created_at DESC" }],
  },

  {
    name: "identity_verification",
    comment: "Identity check state for hosts and guests, decided by an administrator.",
    primaryKey: ["user_id"],
    touchUpdatedAt: true,
    columns: [
      { name: "user_id", type: "uuid", notNull: true, references: "app_user(id) ON DELETE CASCADE" },
      { name: "status", type: "verification_status", notNull: true, default: "'pending'" },
      { name: "document_kind", type: "text" },
      { name: "document_reference", type: "text" },
      { name: "notes", type: "text" },
      { name: "decided_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "decided_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "identity_verification_status_idx", on: "status, created_at DESC" }],
  },

  {
    name: "notification_outbox",
    comment: "Emails queued when an administrator decision affects a member.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "recipient_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "recipient_email", type: "text", notNull: true },
      { name: "template", type: "text", notNull: true },
      { name: "locale", type: "text", notNull: true, default: "'en'" },
      { name: "subject", type: "text", notNull: true },
      { name: "body", type: "text", notNull: true },
      { name: "payload", type: "jsonb", notNull: true, default: "'{}'::jsonb" },
      { name: "status", type: "notification_status", notNull: true, default: "'queued'" },
      { name: "error_message", type: "text" },
      { name: "attempts", type: "integer", notNull: true, default: "0" },
      { name: "last_attempt_at", type: "timestamptz" },
      { name: "next_attempt_at", type: "timestamptz" },
      { name: "provider_message_id", type: "text" },
      { name: "sent_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [{ name: "notification_outbox_status_idx", on: "status, created_at" }],
  },
];
