import { Router } from "express";
import { cfg } from "@/modules/settings/integration-config.js";
import { z } from "zod";

import { env } from "@/config/env.js";
import { apiError } from "@/core/errors.js";
import { asyncHandler, ok } from "@/core/http.js";
import { log } from "@/core/logger.js";
import { validateBody } from "@/core/validate.js";
import { currentUser, requireAuth, requireRole } from "@/middleware/auth.js";
import {
  attachIntentToPendingPayment,
  hostStripeAccount,
  payableBooking,
  pendingIntentForBooking,
  setHostStripeAccount,
} from "@/modules/payments/payments.repository.js";
import { requireStripe, stripeEnabled, stripeStatus, toMinorUnits } from "@/modules/payments/stripe.client.js";

const logger = log("payments");

/**
 * Stripe endpoints. Everything degrades gracefully: while the keys are empty
 * `/config` reports `enabled: false` and the front-end keeps the mock checkout.
 * The webhook lives in `payments.webhook.ts` because it needs the raw body.
 */
export const paymentsRouter = Router();

/** Public: what the checkout screen needs to decide how to collect the card. */
paymentsRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    const status = stripeStatus();
    return ok(res, {
      enabled: status.enabled,
      mode: status.mode,
      publishableKey: status.publishableKey,
      currency: status.currency,
      commissionSplit: true,
    });
  }),
);

/**
 * Creates (or reuses) a PaymentIntent for a booking. The platform commission is
 * kept as an application fee and the rest is transferred to the host's
 * connected account when that account can accept charges.
 */
paymentsRouter.post(
  "/intents",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!stripeEnabled()) throw apiError("CONFLICT", { message: "Card payments are not configured yet." });
    const { bookingReference } = validateBody(z.object({ bookingReference: z.string().trim().min(3).max(120) }), req);
    // Paying requires an account, and the booking must belong to the signed-in member.
    const user = currentUser(req);

    const booking = await payableBooking(bookingReference);
    if (!booking) throw apiError("NOT_FOUND", { message: "That booking does not exist." });
    if (booking.guestId !== user.userId && !user.roles.includes("admin")) {
      throw apiError("FORBIDDEN");
    }

    const stripe = requireStripe();
    const amount = toMinorUnits(booking.totalUsd);
    const commission = toMinorUnits((booking.totalUsd * booking.commissionRate) / 100);
    const canSplit = Boolean(booking.stripeAccountId) && booking.payoutsOnboarded;

    // A guest who reloads the checkout resumes the intent already attached to
    // this booking, instead of leaving an unused hold behind on their card.
    const existingId = await pendingIntentForBooking(booking.id);
    if (existingId) {
      const existing = await stripe.paymentIntents.retrieve(existingId).catch(() => null);
      const reusable =
        existing &&
        existing.amount === amount &&
        ["requires_payment_method", "requires_confirmation", "requires_action"].includes(existing.status);
      if (reusable && existing) {
        return ok(res, {
          clientSecret: existing.client_secret,
          intentId: existing.id,
          amount: booking.totalUsd,
          currency: (booking.currency || env.PAYMENT_CURRENCY).trim(),
          commissionUsd: commission / 100,
          splitToHost: canSplit,
          holdOnly: !booking.instantBook,
        });
      }
      // Not usable any more: release it so no stray hold stays on the card.
      if (existing && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(existing.status)) {
        await stripe.paymentIntents.cancel(existing.id).catch(() => undefined);
      }
    }

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: (booking.currency || env.PAYMENT_CURRENCY).trim().toLowerCase(),
      // Cards only: no Klarna, Amazon Pay or Satispay at checkout.
      payment_method_types: ["card"],
      // A request the host can still refuse is only held on the card: the
      // money is taken when the host accepts, and released if they refuse.
      capture_method: booking.instantBook ? "automatic" : "manual",
      description: `${booking.propertyName} — ${booking.reference}`,
      receipt_email: booking.guestEmail ?? undefined,
      metadata: {
        bookingId: booking.id,
        bookingReference: booking.reference,
        hostId: booking.hostId,
        commissionRate: String(booking.commissionRate),
      },
      ...(canSplit
        ? {
            application_fee_amount: commission,
            transfer_data: { destination: booking.stripeAccountId as string },
          }
        : {}),
    });

    await attachIntentToPendingPayment({
      bookingId: booking.id,
      intentId: intent.id,
      amount: booking.totalUsd,
      // A destination charge already pays the host, so the payout register
      // must skip this booking later on.
      hostSettled: canSplit,
    });

    return ok(res, {
      clientSecret: intent.client_secret,
      intentId: intent.id,
      amount: booking.totalUsd,
      currency: (booking.currency || env.PAYMENT_CURRENCY).trim(),
      commissionUsd: commission / 100,
      splitToHost: canSplit,
      holdOnly: !booking.instantBook,
    });
  }),
);

/** Where the host stands with Stripe Connect onboarding. */
paymentsRouter.get(
  "/connect/status",
  requireAuth,
  requireRole("host", "admin"),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const stored = await hostStripeAccount(user.userId);
    if (!stripeEnabled() || !stored?.accountId) {
      return ok(res, {
        enabled: stripeEnabled(),
        accountId: stored?.accountId ?? null,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      });
    }

    const stripe = requireStripe();
    const account = await stripe.accounts.retrieve(stored.accountId);
    await setHostStripeAccount({
      hostId: user.userId,
      accountId: account.id,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      detailsSubmitted: Boolean(account.details_submitted),
    });

    return ok(res, {
      enabled: true,
      accountId: account.id,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      detailsSubmitted: Boolean(account.details_submitted),
      requirements: account.requirements?.currently_due ?? [],
    });
  }),
);

/**
 * Starts or resumes Stripe Connect onboarding and hands back the hosted link
 * the host has to open.
 */
paymentsRouter.post(
  "/connect/onboarding-link",
  requireAuth,
  requireRole("host", "admin"),
  asyncHandler(async (req, res) => {
    if (!stripeEnabled()) throw apiError("CONFLICT", { message: "Payouts are not configured yet." });
    const user = currentUser(req);
    const stripe = requireStripe();
    // France by default (the platform is French); a host based elsewhere can
    // send their own country, which Stripe then fixes on the account.
    const { country } = validateBody(
      z.object({ country: z.string().trim().length(2).toUpperCase().optional() }),
      req,
    );

    let accountId = (await hostStripeAccount(user.userId))?.accountId ?? null;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user.email,
        country: country || cfg("STRIPE_CONNECT_COUNTRY") || undefined,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_type: "individual",
        metadata: { hostId: user.userId },
      });
      accountId = account.id;
      await setHostStripeAccount({
        hostId: user.userId,
        accountId: account.id,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      });
      logger.info({ hostId: user.userId, accountId }, "stripe connected account created");
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${env.APP_PUBLIC_URL}/host?section=payouts&stripe=refresh`,
      return_url: `${env.APP_PUBLIC_URL}/host?section=payouts&stripe=done`,
    });

    return ok(res, { url: link.url, accountId, expiresAt: new Date(link.expires_at * 1000).toISOString() });
  }),
);

/** Opens the Stripe Express dashboard so the host can see their payouts. */
paymentsRouter.post(
  "/connect/dashboard-link",
  requireAuth,
  requireRole("host", "admin"),
  asyncHandler(async (req, res) => {
    if (!stripeEnabled()) throw apiError("CONFLICT", { message: "Payouts are not configured yet." });
    const user = currentUser(req);
    const stored = await hostStripeAccount(user.userId);
    if (!stored?.accountId) throw apiError("PAYOUT_NOT_READY");
    const stripe = requireStripe();
    const link = await stripe.accounts.createLoginLink(stored.accountId);
    return ok(res, { url: link.url });
  }),
);
