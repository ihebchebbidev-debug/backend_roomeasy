import { env } from "@/config/env.js";
import { apiError } from "@/core/errors.js";
import { log } from "@/core/logger.js";
import { hostStripeAccount } from "@/modules/payments/payments.repository.js";
import { requireStripe, stripeEnabled, toMinorUnits } from "@/modules/payments/stripe.client.js";

const logger = log("payouts");

/**
 * Moves a payout to the host's Stripe Connect (Express) account.
 *
 * Call this BEFORE marking the payout as paid in our own tables, so a Stripe
 * failure never leaves the register claiming money left the platform. Returns
 * the Stripe transfer id, or null when Stripe is not configured at all (the
 * register then stays a bookkeeping-only record, as before).
 */
export async function transferPayoutToHost(input: {
  payoutId: string;
  hostId: string | null;
  amountUsd: number;
}): Promise<string | null> {
  if (!stripeEnabled()) return null;
  if (input.amountUsd <= 0) return null;
  if (!input.hostId) {
    throw apiError("PAYOUT_NOT_READY", { message: "This payout is not attached to a host account." });
  }

  const account = await hostStripeAccount(input.hostId);
  if (!account?.accountId || !account.payoutsEnabled) {
    throw apiError("PAYOUT_NOT_READY", {
      message: "This host has not finished payout onboarding yet, so the money cannot be sent.",
      details: { hostId: input.hostId },
    });
  }

  const transfer = await requireStripe().transfers.create(
    {
      amount: toMinorUnits(input.amountUsd),
      currency: env.PAYMENT_CURRENCY.toLowerCase(),
      destination: account.accountId,
      description: `Payout ${input.payoutId}`,
      metadata: { payoutId: input.payoutId, hostId: input.hostId },
    },
    // Replaying the same payout can never send the money twice.
    { idempotencyKey: `payout_${input.payoutId}` },
  );

  logger.info(
    { payoutId: input.payoutId, hostId: input.hostId, transferId: transfer.id, amountUsd: input.amountUsd },
    "payout transferred to host",
  );
  return transfer.id;
}
