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
  /** Instant-book stays confirm on payment; others need the host's answer. */
  instantBook: boolean;
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
    instant_book: boolean;
  }>(
    `SELECT b.id, b.reference, b.guest_id, b.guest_email, b.guest_name, b.status::text AS status,
            b.currency, b.total_usd, p.name AS property_name,
            hp.user_id AS host_id, hu.email AS host_email,
            COALESCE(b.commission_rate, hc.commission_rate, ps.commission_rate) AS commission_rate,
            hp.stripe_account_id, hp.payouts_onboarded, p.instant_book
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
    instantBook: row.instant_book,
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
  /** True when the charge itself already routed the host share to the host. */
  hostSettled?: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO payment (booking_id, method, brand, last4, status, amount_usd, reference,
                          stripe_payment_intent_id, stripe_charge_id, host_settled)
     VALUES ($1, 'card', $2::card_brand, $3, $4::payment_status, $5, $6, $6, $7, $8)
     ON CONFLICT (reference) DO UPDATE
        SET status = EXCLUDED.status,
            brand = EXCLUDED.brand,
            last4 = EXCLUDED.last4,
            stripe_charge_id = COALESCE(EXCLUDED.stripe_charge_id, payment.stripe_charge_id),
            -- Once a charge has paid the host directly it stays settled.
            host_settled = payment.host_settled OR EXCLUDED.host_settled`,
    [
      input.bookingId,
      input.brand ?? "card",
      input.last4 ?? "0000",
      input.status,
      input.amount,
      input.intentId,
      input.chargeId ?? null,
      input.hostSettled ?? false,
    ],
    { label: "payments.record" },
  );
}

/**
 * Records money sent back. A partial refund keeps the payment where it is and
 * only stores the amount returned: "refunded" means the whole charge went back.
 */
export async function markPaymentRefunded(intentId: string, refundedAmount: number): Promise<void> {
  await query(
    `UPDATE payment
        SET refunded_usd = $2,
            status = CASE WHEN $2 >= amount_usd THEN 'refunded'::payment_status ELSE status END
      WHERE stripe_payment_intent_id = $1`,
    [intentId, refundedAmount],
    { label: "payments.refunded" },
  );
}

/**
 * The PaymentIntent already attached to a booking's pending payment, so a
 * guest who reloads the checkout resumes it instead of leaving a stray hold.
 */
export async function pendingIntentForBooking(bookingId: string): Promise<string | null> {
  const row = await queryOne<{ stripe_payment_intent_id: string | null }>(
    `SELECT stripe_payment_intent_id
       FROM payment
      WHERE booking_id = $1 AND status = 'pending' AND stripe_payment_intent_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId],
    { label: "payments.pendingIntent" },
  );
  return row?.stripe_payment_intent_id ?? null;
}

/**
 * The Stripe references of a booking's live payment, so a decline or a
 * cancellation can send the money back through Stripe instead of only writing
 * `refunded` in our own table.
 */
export async function stripePaymentForBooking(bookingId: string): Promise<{
  intentId: string | null;
  chargeId: string | null;
  status: string;
  amountUsd: number;
} | null> {
  const row = await queryOne<{
    stripe_payment_intent_id: string | null;
    stripe_charge_id: string | null;
    status: string;
    amount_usd: string;
  }>(
    `SELECT stripe_payment_intent_id, stripe_charge_id, status, amount_usd
       FROM payment
      WHERE booking_id = $1 AND status IN ('authorized', 'paid')
      ORDER BY created_at DESC
      LIMIT 1`,
    [bookingId],
    { label: "payments.forBooking" },
  );
  if (!row) return null;
  return {
    intentId: row.stripe_payment_intent_id,
    chargeId: row.stripe_charge_id,
    status: row.status,
    amountUsd: Number(row.amount_usd),
  };
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
  /** True when this intent pays the host share straight to their account. */
  hostSettled?: boolean;
}): Promise<void> {
  const updated = await queryOne<{ id: string }>(
    `UPDATE payment
        SET stripe_payment_intent_id = $2,
            reference = $2,
            amount_usd = $3,
            host_settled = payment.host_settled OR $4
      WHERE booking_id = $1
        AND status = 'pending'
      RETURNING id`,
    [input.bookingId, input.intentId, input.amount, input.hostSettled ?? false],
    { label: "payments.attachIntent" },
  );
  if (updated) return;
  await recordStripePayment({
    bookingId: input.bookingId,
    intentId: input.intentId,
    status: "pending",
    amount: input.amount,
    hostSettled: input.hostSettled ?? false,
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

/**
 * Saves the connected-account id and onboarding state for a host and reports
 * whether payouts have just become possible, so the "payouts ready" e-mail is
 * sent once on the transition instead of on every `account.updated` delivery.
 */
export async function setHostStripeAccount(input: {
  hostId: string;
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}): Promise<{ payoutsJustEnabled: boolean }> {
  const row = await queryOne<{ was_ready: boolean }>(
    // `prev` reads the row as it stood before the update, so `was_ready` is the
    // previous state (a plain RETURNING would hand back the new values).
    `WITH prev AS (
       SELECT user_id, (stripe_payouts_enabled AND stripe_details_submitted) AS was_ready
         FROM host_profile WHERE user_id = $1
     )
     UPDATE host_profile h
        SET stripe_account_id = $2,
            stripe_charges_enabled = $3,
            stripe_payouts_enabled = $4,
            stripe_details_submitted = $5,
            payouts_onboarded = $4,
            payout_reference = COALESCE(h.payout_reference, $2)
       FROM prev
      WHERE h.user_id = prev.user_id
      RETURNING prev.was_ready`,
    [input.hostId, input.accountId, input.chargesEnabled, input.payoutsEnabled, input.detailsSubmitted],
    { label: "payments.host-account" },
  );

  const isReady = input.payoutsEnabled && input.detailsSubmitted;
  return { payoutsJustEnabled: isReady && !row?.was_ready };
}


/**
 * Stores the identity state Stripe reports for a host's connected account.
 * The platform never collects documents: this is the only source the admin
 * uses to approve or reject the host.
 */
export async function recordStripeIdentity(input: {
  hostId: string;
  accountId: string;
  status: "unverified" | "pending" | "verified" | "requirements_due";
  requirements: string[];
}): Promise<void> {
  await query(
    `INSERT INTO identity_verification (user_id, status, stripe_account_id, stripe_status, stripe_requirements, stripe_checked_at)
     VALUES ($1, 'pending', $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE
        SET stripe_account_id = EXCLUDED.stripe_account_id,
            stripe_status = EXCLUDED.stripe_status,
            stripe_requirements = EXCLUDED.stripe_requirements,
            stripe_checked_at = now()`,
    [input.hostId, input.accountId, input.status, input.requirements],
    { label: "payments.stripe-identity" },
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
