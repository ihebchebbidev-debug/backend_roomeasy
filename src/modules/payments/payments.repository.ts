import { query, queryOne } from "@/db/query.js";

export type PayableBooking = {
  id: string;
  reference: string;
  guestId: string | null;
  guestEmail: string | null;
  guestName: string;
  status: string;
  currency: string;
  totalUsd: number;
  propertyName: string;
  hostId: string;
  hostEmail: string | null;
  /** Commission actually applied: the host override, else the platform rate. */
  commissionRate: number;
  stripeAccountId: string | null;
  payoutsOnboarded: boolean;
};

/** Everything the Stripe layer needs about one booking, in a single round trip. */
export async function payableBooking(idOrReference: string): Promise<PayableBooking | null> {
  const row = await queryOne<{
    id: string;
    reference: string;
    guest_id: string | null;
    guest_email: string | null;
    guest_name: string;
    status: string;
    currency: string;
    total_usd: string;
    property_name: string;
    host_id: string;
    host_email: string | null;
    commission_rate: string;
    stripe_account_id: string | null;
    payouts_onboarded: boolean;
  }>(
    `SELECT b.id, b.reference, b.guest_id, b.guest_email, b.guest_name, b.status::text AS status,
            b.currency, b.total_usd, p.name AS property_name,
            hp.user_id AS host_id, hu.email AS host_email,
            COALESCE(hc.commission_rate, ps.commission_rate) AS commission_rate,
            hp.stripe_account_id, hp.payouts_onboarded
       FROM booking b
       JOIN property p ON p.id = b.property_id
       JOIN host_profile hp ON hp.user_id = p.host_id
       JOIN app_user hu ON hu.id = hp.user_id
       LEFT JOIN host_commission hc ON hc.host_id = hp.user_id
       CROSS JOIN platform_settings ps
      WHERE b.id = $1 OR b.reference = $1
      LIMIT 1`,
    [idOrReference],
    { label: "payments.booking" },
  );

  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    guestId: row.guest_id,
    guestEmail: row.guest_email,
    guestName: row.guest_name,
    status: row.status,
    currency: row.currency,
    totalUsd: Number(row.total_usd),
    propertyName: row.property_name,
    hostId: row.host_id,
    hostEmail: row.host_email,
    commissionRate: Number(row.commission_rate),
    stripeAccountId: row.stripe_account_id,
    payoutsOnboarded: row.payouts_onboarded,
  };
}

/** Stores or updates the Stripe payment row that belongs to a booking. */
export async function recordStripePayment(input: {
  bookingId: string;
  intentId: string;
  status: "pending" | "authorized" | "paid" | "failed" | "refunded";
  amount: number;
  brand?: string;
  last4?: string;
  chargeId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO payment (booking_id, method, brand, last4, status, amount_usd, reference,
                          stripe_payment_intent_id, stripe_charge_id)
     VALUES ($1, 'card', $2::card_brand, $3, $4::payment_status, $5, $6, $6, $7)
     ON CONFLICT (reference) DO UPDATE
        SET status = EXCLUDED.status,
            brand = EXCLUDED.brand,
            last4 = EXCLUDED.last4,
            stripe_charge_id = COALESCE(EXCLUDED.stripe_charge_id, payment.stripe_charge_id)`,
    [
      input.bookingId,
      input.brand ?? "card",
      input.last4 ?? "0000",
      input.status,
      input.amount,
      input.intentId,
      input.chargeId ?? null,
    ],
    { label: "payments.record" },
  );
}

export async function markPaymentRefunded(intentId: string, refundedAmount: number): Promise<void> {
  await query(
    `UPDATE payment SET status = 'refunded', refunded_usd = $2 WHERE stripe_payment_intent_id = $1`,
    [intentId, refundedAmount],
    { label: "payments.refunded" },
  );
}

/**
 * Ties a fresh PaymentIntent to the booking's pending payment row (created when
 * the guest chose Stripe) so the webhook later flips that same row to paid
 * instead of leaving a duplicate behind.
 */
export async function attachIntentToPendingPayment(input: {
  bookingId: string;
  intentId: string;
  amount: number;
}): Promise<void> {
  const updated = await queryOne<{ id: string }>(
    `UPDATE payment
        SET stripe_payment_intent_id = $2,
            reference = $2,
            amount_usd = $3
      WHERE booking_id = $1
        AND status = 'pending'
      RETURNING id`,
    [input.bookingId, input.intentId, input.amount],
    { label: "payments.attachIntent" },
  );
  if (updated) return;
  await recordStripePayment({
    bookingId: input.bookingId,
    intentId: input.intentId,
    status: "pending",
    amount: input.amount,
  });
}

export async function confirmBookingPaid(intentId: string): Promise<string | null> {
  const row = await queryOne<{ booking_id: string }>(
    `UPDATE payment SET status = 'paid' WHERE stripe_payment_intent_id = $1 RETURNING booking_id`,
    [intentId],
    { label: "payments.confirm" },
  );
  return row?.booking_id ?? null;
}

/** Saves the connected-account id and onboarding state for a host. */
export async function setHostStripeAccount(input: {
  hostId: string;
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<void> {
  await query(
    `UPDATE host_profile
        SET stripe_account_id = $2,
            stripe_charges_enabled = $3,
            stripe_payouts_enabled = $4,
            stripe_details_submitted = $5,
            payouts_onboarded = $4,
            payout_reference = COALESCE(payout_reference, $2)
      WHERE user_id = $1`,
    [input.hostId, input.accountId, input.chargesEnabled, input.payoutsEnabled, input.detailsSubmitted],
    { label: "payments.host-account" },
  );
}

export async function hostStripeAccount(hostId: string): Promise<{
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
} | null> {
  const row = await queryOne<{
    stripe_account_id: string | null;
    stripe_charges_enabled: boolean;
    stripe_payouts_enabled: boolean;
    stripe_details_submitted: boolean;
  }>(
    `SELECT stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted
       FROM host_profile WHERE user_id = $1`,
    [hostId],
    { label: "payments.host-account.read" },
  );
  if (!row) return null;
  return {
    accountId: row.stripe_account_id,
    chargesEnabled: row.stripe_charges_enabled,
    payoutsEnabled: row.stripe_payouts_enabled,
    detailsSubmitted: row.stripe_details_submitted,
  };
}

export async function hostIdForAccount(accountId: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    "SELECT user_id FROM host_profile WHERE stripe_account_id = $1",
    [accountId],
    { label: "payments.host-by-account" },
  );
  return row?.user_id ?? null;
}
