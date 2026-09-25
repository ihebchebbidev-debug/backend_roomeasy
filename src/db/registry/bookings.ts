import type { TableDef } from "@/db/registry/types.js";

/** Bookings, price lines, payments, cancellations and payouts. */
export const bookingTables: TableDef[] = [
  {
    name: "booking",
    primaryKey: ["id"],
    touchUpdatedAt: true,
    columns: [
      { name: "id", type: "text", notNull: true },
      { name: "reference", type: "text", notNull: true, unique: true },
      { name: "property_id", type: "text", notNull: true, references: "property(id) ON DELETE RESTRICT" },
      { name: "guest_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "guest_name", type: "text", notNull: true },
      { name: "guest_email", type: "text" },
      { name: "guest_phone", type: "text" },
      { name: "message", type: "text" },
      { name: "check_in", type: "date", notNull: true },
      { name: "check_out", type: "date", notNull: true },
      { name: "nights", type: "integer", generated: "check_out - check_in" },
      { name: "guests", type: "integer", notNull: true, default: "1", check: "guests BETWEEN 1 AND 64" },
      { name: "status", type: "booking_status", notNull: true, default: "'pending'" },
      { name: "is_mobile_booking", type: "boolean", notNull: true, default: "false" },
      { name: "currency", type: "char(3)", notNull: true, default: "'EUR'", note: "Listing currency at booking time; every amount on this row is in it." },
      { name: "fx_rate_to_eur", type: "numeric(14,6)", notNull: true, default: "1", note: "Units of `currency` per 1 EUR on the booking day, frozen for receipts and finance." },
      { name: "nightly_usd", type: "numeric(12,2)", notNull: true, default: "0", check: "nightly_usd >= 0" },
      { name: "base_subtotal", type: "numeric(12,2)", notNull: true, default: "0", check: "base_subtotal >= 0" },
      { name: "subtotal", type: "numeric(12,2)", notNull: true, default: "0", check: "subtotal >= 0" },
      { name: "cleaning_fee", type: "numeric(12,2)", notNull: true, default: "0", check: "cleaning_fee >= 0" },
      { name: "service_fee", type: "numeric(12,2)", notNull: true, default: "0", check: "service_fee >= 0" },
      { name: "taxes", type: "numeric(12,2)", notNull: true, default: "0", check: "taxes >= 0" },
      { name: "total_usd", type: "numeric(12,2)", notNull: true, default: "0", check: "total_usd >= 0" },
      { name: "commission_rate", type: "numeric(5,2)", notNull: true, check: "commission_rate BETWEEN 0 AND 100", note: "Commission rate frozen at booking time; backfilled and enforced NOT NULL by a finaliser." },
      { name: "decided_at", type: "timestamptz", note: "When the host accepted or declined the request." },
      { name: "decided_by", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
      { name: "updated_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    constraints: [
      { name: "booking_dates_ordered", definition: "CHECK (check_out > check_in)" },
      {
        name: "booking_no_overlap",
        definition:
          "EXCLUDE USING gist (property_id WITH =, daterange(check_in, check_out, '[)') WITH &&) WHERE (status IN ('pending', 'confirmed', 'completed'))",
      },
    ],
    indexes: [
      { name: "booking_property_idx", on: "property_id, check_in" },
      { name: "booking_guest_idx", on: "guest_id, check_in DESC" },
      { name: "booking_status_idx", on: "status" },
      { name: "booking_status_created_idx", on: "status, created_at DESC" },
      { name: "booking_created_idx", on: "created_at DESC" },
      { name: "booking_property_status_idx", on: "property_id, status" },
    ],
  },

  {
    name: "booking_discount",
    primaryKey: ["booking_id", "kind"],
    columns: [
      { name: "booking_id", type: "text", notNull: true, references: "booking(id) ON DELETE CASCADE" },
      { name: "kind", type: "discount_kind", notNull: true },
      { name: "percent", type: "numeric(5,2)", notNull: true, check: "percent BETWEEN 0 AND 90" },
      { name: "amount_usd", type: "numeric(12,2)", notNull: true, check: "amount_usd >= 0" },
    ],
  },

  {
    name: "payment",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "booking_id", type: "text", notNull: true, references: "booking(id) ON DELETE CASCADE" },
      { name: "method", type: "payment_method", notNull: true, default: "'card'" },
      { name: "brand", type: "card_brand", notNull: true, default: "'card'" },
      { name: "last4", type: "char(4)", notNull: true, check: "last4 ~ '^[0-9]{4}$'" },
      { name: "status", type: "payment_status", notNull: true, default: "'authorized'" },
      { name: "amount_usd", type: "numeric(12,2)", notNull: true, default: "0", check: "amount_usd >= 0" },
      { name: "reference", type: "text", notNull: true, unique: true },
      { name: "refunded_usd", type: "numeric(12,2)", notNull: true, default: "0", check: "refunded_usd >= 0" },
      { name: "stripe_payment_intent_id", type: "text" },
      { name: "stripe_charge_id", type: "text" },
      // True when the charge itself already routed the host share to the
      // connected account (Stripe destination charge), so the payout register
      // must never pay that booking a second time.
      { name: "host_settled", type: "boolean", notNull: true, default: "false" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "payment_booking_idx", on: "booking_id" },
      { name: "payment_intent_idx", on: "stripe_payment_intent_id" },
      { name: "payment_status_created_idx", on: "status, created_at DESC" },
    ],
  },

  {
    name: "booking_cancellation",
    primaryKey: ["booking_id"],
    columns: [
      { name: "booking_id", type: "text", notNull: true, references: "booking(id) ON DELETE CASCADE" },
      { name: "cancelled_by", type: "actor_role", notNull: true },
      { name: "cancelled_by_id", type: "uuid", references: "app_user(id) ON DELETE SET NULL" },
      { name: "policy", type: "cancellation_policy", notNull: true },
      { name: "refund_percent", type: "numeric(5,2)", notNull: true, check: "refund_percent BETWEEN 0 AND 100" },
      { name: "refund_usd", type: "numeric(12,2)", notNull: true, check: "refund_usd >= 0" },
      { name: "reason", type: "text" },
      { name: "cancelled_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
  },

  {
    name: "payout",
    primaryKey: ["id"],
    columns: [
      { name: "id", type: "text", notNull: true },
      { name: "host_id", type: "uuid", references: "host_profile(user_id) ON DELETE SET NULL" },
      { name: "host_name", type: "text", notNull: true },
      { name: "amount_usd", type: "numeric(12,2)", notNull: true, check: "amount_usd >= 0" },
      { name: "commission_usd", type: "numeric(12,2)", notNull: true, default: "0", check: "commission_usd >= 0" },
      { name: "currency", type: "char(3)", notNull: true, default: "'EUR'", note: "Currency of every booking in this payout; the transfer is sent in it." },
      { name: "status", type: "payout_status", notNull: true, default: "'scheduled'" },
      { name: "payout_date", type: "date", notNull: true, default: "CURRENT_DATE" },
      { name: "stripe_transfer_id", type: "text" },
      { name: "paid_at", type: "timestamptz" },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "payout_host_idx", on: "host_id, payout_date DESC" },
      { name: "payout_status_idx", on: "status, payout_date DESC" },
    ],
  },

  {
    name: "payout_item",
    primaryKey: ["payout_id", "booking_id"],
    columns: [
      { name: "payout_id", type: "text", notNull: true, references: "payout(id) ON DELETE CASCADE" },
      { name: "booking_id", type: "text", notNull: true, references: "booking(id) ON DELETE RESTRICT" },
      { name: "amount_usd", type: "numeric(12,2)", notNull: true, check: "amount_usd >= 0" },
    ],
  },
];
