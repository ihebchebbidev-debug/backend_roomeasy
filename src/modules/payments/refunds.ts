import { stripePaymentForBooking } from "@/modules/payments/payments.repository.js";
import { requireStripe, stripeEnabled, toMinorUnits } from "@/modules/payments/stripe.client.js";

/**
 * Sends money back through Stripe for a booking, when Stripe is configured and
 * a real charge exists. Call this BEFORE writing "refunded" in our own tables
 * so a Stripe failure never leaves the database claiming money moved.
 */
export async function refundThroughStripe(bookingId: string, amountUsd: number): Promise<string | null> {
  if (!stripeEnabled() || amountUsd <= 0) return null;
  const payment = await stripePaymentForBooking(bookingId);
  if (!payment || (!payment.intentId && !payment.chargeId)) return null;

  const stripe = requireStripe();

  // Money still only held on the card was never taken: release the hold
  // instead of refunding a charge that does not exist.
  if (payment.intentId) {
    const intent = await stripe.paymentIntents.retrieve(payment.intentId);
    if (
      intent.status === "requires_capture" ||
      intent.status === "requires_payment_method" ||
      intent.status === "requires_confirmation" ||
      intent.status === "requires_action"
    ) {
      await stripe.paymentIntents.cancel(payment.intentId, { cancellation_reason: "requested_by_customer" });
      return null;
    }
    if (intent.status === "canceled") return null;
  }

  // Part of the money may already have been sent back (a partial refund, then
  // a cancellation). Stripe rejects a refund larger than what is left on the
  // charge, so only ever ask for the remaining amount.
  let remainingMinor = toMinorUnits(payment.amountUsd);
  try {
    const chargeId =
      payment.chargeId ??
      (payment.intentId
        ? ((await stripe.paymentIntents.retrieve(payment.intentId)).latest_charge as string | null)
        : null);
    if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId);
      remainingMinor = Math.max(0, (charge.amount_captured || charge.amount) - (charge.amount_refunded || 0));
    }
  } catch {
    // Reading the charge is only an optimisation: fall back to the booking amount.
  }
  if (remainingMinor <= 0) return null;

  const amountMinor = Math.min(toMinorUnits(amountUsd), remainingMinor);
  if (amountMinor <= 0) return null;

  const refund = await stripe.refunds.create({
    ...(payment.intentId ? { payment_intent: payment.intentId } : { charge: payment.chargeId as string }),
    amount: amountMinor,
    metadata: { bookingId },
  });
  return refund.id;
}

/**
 * Takes the money that was only held on the guest's card. Called when the host
 * accepts a request; a booking paid outright (instant book) is already
 * captured and is left untouched.
 */
export async function capturePaymentForBooking(bookingId: string): Promise<void> {
  if (!stripeEnabled()) return;
  const payment = await stripePaymentForBooking(bookingId);
  if (!payment?.intentId) return;

  const stripe = requireStripe();
  const intent = await stripe.paymentIntents.retrieve(payment.intentId);
  if (intent.status !== "requires_capture") return;
  await stripe.paymentIntents.capture(payment.intentId, {}, { idempotencyKey: `capture_${payment.intentId}` });
}
