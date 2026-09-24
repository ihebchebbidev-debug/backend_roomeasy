import { notifyBookingEvent } from "@/modules/notifications/bookingEmails.js";
import type { Request, Response } from "express";
import type Stripe from "stripe";

import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { query } from "@/db/query.js";
import { queueNotification } from "@/modules/admin/notifications.repository.js";
import {
  confirmBookingPaid,
  hostIdForAccount,
  markPaymentRefunded,
  recordStripePayment,
  setHostStripeAccount,
  recordStripeIdentity,
} from "@/modules/payments/payments.repository.js";
import { fromMinorUnits, requireStripe, stripeEnabled } from "@/modules/payments/stripe.client.js";

const logger = log("stripe-webhook");

/**
 * `POST /api/payments/webhook` — mounted with a raw body parser in app.ts so the
 * signature can be verified. Point the Stripe dashboard endpoint at:
 *   https://<api-domain>/api/payments/webhook
 * and copy the signing secret into STRIPE_WEBHOOK_SECRET.
 *
 * Subscribed events: payment_intent.succeeded, payment_intent.payment_failed,
 * charge.refunded, account.updated, payout.paid.
 */
export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!stripeEnabled() || !env.STRIPE_WEBHOOK_SECRET) {
    res.status(503).json({ error: { code: "CONFLICT", message: "Stripe is not configured." } });
    return;
  }

  const signature = req.header("stripe-signature");
  if (!signature) {
    res.status(400).json({ error: { code: "FORBIDDEN", message: "Missing stripe-signature header." } });
    return;
  }

  let event: Stripe.Event;
  try {
    const stripe = requireStripe();
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    logger.warn({ err: error instanceof Error ? error.message : error }, "invalid stripe signature");
    res.status(400).json({ error: { code: "FORBIDDEN", message: "Invalid signature." } });
    return;
  }

  try {
    await handleEvent(event);
  } catch (error) {
    logger.error({ err: error, type: event.type }, "stripe event handling failed");
    // 500 makes Stripe retry the delivery.
    res.status(500).json({ received: false });
    return;
  }

  res.status(200).json({ received: true });
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const bookingId = intent.metadata?.["bookingId"] ?? null;
      const card = intent.payment_method as unknown as { card?: { brand?: string; last4?: string } } | null;

      if (bookingId) {
        await recordStripePayment({
          bookingId,
          intentId: intent.id,
          status: "paid",
          amount: fromMinorUnits(intent.amount_received || intent.amount),
          brand: card?.card?.brand,
          last4: card?.card?.last4,
          chargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : null,
          // Destination charge: the host share left with the charge itself.
          hostSettled: Boolean(intent.transfer_data?.destination),
        });
        // Paying never overrides the host's decision: only an instant-book
        // stay confirms itself. A request stays `pending` until the host
        // accepts it.
        const confirmedNow = await query<{ id: string }>(
          `UPDATE booking b SET status = 'confirmed', updated_at = now()
             FROM property p
            WHERE b.id = $1 AND b.status = 'pending'
              AND p.id = b.property_id AND p.instant_book
            RETURNING b.id`,
          [bookingId],
          { label: "webhook.booking-confirm" },
        );
        if (confirmedNow.length) void notifyBookingEvent(bookingId, "confirmed");

      } else {
        await confirmBookingPaid(intent.id);
      }
      logger.info({ intent: intent.id, bookingId }, "payment succeeded");
      break;
    }

    // Manual capture: the card is only held. Record the authorisation so the
    // booking shows as covered while the host decides.
    case "payment_intent.amount_capturable_updated": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const bookingId = intent.metadata?.["bookingId"] ?? null;
      if (bookingId) {
        const card = intent.payment_method as unknown as { card?: { brand?: string; last4?: string } } | null;
        await recordStripePayment({
          bookingId,
          intentId: intent.id,
          status: "authorized",
          amount: fromMinorUnits(intent.amount_capturable || intent.amount),
          brand: card?.card?.brand,
          last4: card?.card?.last4,
          chargeId: typeof intent.latest_charge === "string" ? intent.latest_charge : null,
          hostSettled: Boolean(intent.transfer_data?.destination),
        });
        void notifyBookingEvent(bookingId, "created");
      }
      logger.info({ intent: intent.id, bookingId }, "payment authorised (held)");
      break;
    }

    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;
      const bookingId = intent.metadata?.["bookingId"] ?? null;
      if (bookingId) {
        await recordStripePayment({
          bookingId,
          intentId: intent.id,
          status: "failed",
          amount: fromMinorUnits(intent.amount),
        });
      }
      logger.warn({ intent: intent.id, reason: intent.last_payment_error?.message }, "payment failed");
      break;
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
      if (intentId) await markPaymentRefunded(intentId, fromMinorUnits(charge.amount_refunded));
      break;
    }

    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      const hostId = (account.metadata?.["hostId"] as string | undefined) ?? (await hostIdForAccount(account.id));
      if (hostId) {
        const { payoutsJustEnabled } = await setHostStripeAccount({
          hostId,
          accountId: account.id,
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
          detailsSubmitted: Boolean(account.details_submitted),
        });
        const individual = (account as unknown as { individual?: { verification?: { status?: string } } }).individual;
        const due = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])];
        const reported = individual?.verification?.status;
        await recordStripeIdentity({
          hostId,
          accountId: account.id,
          status: reported === "verified" && due.length === 0
            ? "verified"
            : reported === "pending"
              ? "pending"
              : due.length
                ? "requirements_due"
                : account.details_submitted
                  ? "pending"
                  : "unverified",
          requirements: due,
        });
        // Only on the false -> true transition: Stripe re-sends
        // `account.updated` for any account change and retries deliveries.
        if (payoutsJustEnabled) {
          await queueNotification({
            recipientId: hostId,
            template: "payouts_ready",
            subject: "Your payout account is ready",
            body: "Your bank details are verified. Payouts for your completed stays will now be sent automatically.",
            payload: { accountId: account.id },
          });
        }

      }
      break;
    }

    default:
      logger.debug({ type: event.type }, "unhandled stripe event");
  }
}
