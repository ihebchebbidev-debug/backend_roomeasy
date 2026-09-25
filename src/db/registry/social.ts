import type { TableDef } from "@/db/registry/types.js";

/** Reviews, moderation trail and messaging. */
export const socialTables: TableDef[] = [
  {
    name: "review",
    primaryKey: ["id"],
    touchUpdatedAt: true,
    columns: [
      { name: "id", type: "text", notNull: true },
      { name: "property_id", type: "text", notNull: true, references: "property(id) ON DELETE CASCADE" },
      {
        name: "booking_id",
        type: "text",
        unique: true,
        references: "booking(id) ON DELETE SET NULL",
        note: "One review per stay; the app keys reviews as rv-<bookingId>.",
      },
      { name: "author_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "author_name", type: "text", notNull: true },
      { name: "rating", type: "integer", notNull: true, check: "rating BETWEEN 1 AND 5" },
      { name: "body", type: "text", notNull: true, check: "char_length(body) <= 2000" },
      { name: "reply", type: "text", check: "reply IS NULL OR char_length(reply) <= 2000" },
      { name: "replied_at", type: "timestamptz" },
      { name: "replied_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "hidden", type: "boolean", notNull: true, default: "false" },
      { name: "hidden_at", type: "timestamptz" },
      { name: "hidden_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "hidden_reason", type: "text" },
      { name: "created_on", type: "date", notNull: true, default: "CURRENT_DATE" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    constraints: [{ name: "review_reply_timestamped", definition: "CHECK (reply IS NULL OR replied_at IS NOT NULL)" }],
    indexes: [
      { name: "review_property_idx", on: "property_id, created_on DESC" },
      { name: "review_hidden_idx", on: "hidden" },
      { name: "review_author_idx", on: "author_id" },
    ],
  },

  {
    name: "moderation_log",
    comment: "Who did what to whom — every admin action is recorded.",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "admin_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "action", type: "moderation_action", notNull: true },
      {
        name: "target_kind",
        type: "text",
        notNull: true,
        check:
          "target_kind IN ('review', 'user', 'listing', 'settings', 'payout', 'booking', 'report', 'ticket', 'commission')",
      },
      { name: "target_id", type: "text", notNull: true },
      { name: "reason", type: "text" },
      { name: "metadata", type: "jsonb", notNull: true, default: "'{}'::jsonb" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "moderation_log_target_idx", on: "target_kind, target_id" },
      { name: "moderation_log_created_idx", on: "created_at DESC" },
    ],
  },

  {
    name: "message_thread",
    primaryKey: ["id"],
    touchUpdatedAt: true,
    columns: [
      { name: "id", type: "text", notNull: true },
      { name: "property_id", type: "text", references: "property(id) ON DELETE SET NULL" },
      { name: "booking_id", type: "text", references: "booking(id) ON DELETE SET NULL" },
      { name: "guest_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "host_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "with_name", type: "text", notNull: true, default: "''" },
      { name: "closed", type: "boolean", notNull: true, default: "false" },
      { name: "last_message_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "message_thread_property_idx", on: "property_id" },
      { name: "message_thread_guest_idx", on: "guest_id" },
      { name: "message_thread_host_idx", on: "host_id" },
      { name: "message_thread_recent_idx", on: "coalesce(last_message_at, created_at) DESC" },
    ],
  },

  {
    name: "message",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "legacy_id", type: "text" },
      { name: "thread_id", type: "text", notNull: true, references: "message_thread(id) ON DELETE CASCADE" },
      { name: "sender_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "sender_role", type: "actor_role", notNull: true, default: "'guest'" },
      { name: "body", type: "text", notNull: true },
      { name: "sent_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "read_at", type: "timestamptz" },
    ],
    constraints: [{ name: "message_legacy_unique", definition: "UNIQUE (thread_id, legacy_id)" }],
    indexes: [
      { name: "message_thread_idx", on: "thread_id, sent_at" },
      { name: "message_unread_idx", on: "thread_id, sender_id", where: "read_at IS NULL" },
    ],
  },
];
