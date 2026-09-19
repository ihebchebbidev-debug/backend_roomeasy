import { stripePaymentForBooking } from "@/modules/payments/payments.repository.js";
import { requireStripe, stripeEnabled, toMinorUnits } from "@/modules/payments/stripe.client.js";

/**
 * Sends money back through Stripe for a booking, when Stripe is configured and
 * a real charge exists. Call this BEFORE writing "refunded" in our own tables
 * so a Stripe failure never leaves the database claiming money moved.
 */
export async function refundThroughStripe(bookingId: string, amountUsd: number): Promise<void> {
  if (!stripeEnabled() || amountUsd <= 0) return;
  const payment = await stripePaymentForBooking(bookingId);
  if (!payment || (!payment.intentId && !payment.chargeId)) return;

  const stripe = requireStripe();
  await stripe.refunds.create({
    ...(payment.intentId ? { payment_intent: payment.intentId } : { charge: payment.chargeId as string }),
    amount: toMinorUnits(Math.min(amountUsd, payment.amountUsd)),
    metadata: { bookingId },
  });
}
