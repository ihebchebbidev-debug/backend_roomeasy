import Stripe from "stripe";

import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { cfg, onIntegrationChange } from "@/modules/settings/integration-config.js";

const logger = log("stripe");

/**
 * Stripe is optional: without a secret key the booking flow keeps using the
 * built-in mock charge, so the app runs end to end before the account exists.
 * Fill STRIPE_SECRET_KEY in and every payment goes through Stripe instead.
 */

let client: Stripe | null = null;
onIntegrationChange(() => {
  client = null;
});

export function stripeEnabled(): boolean {
  return cfg("STRIPE_SECRET_KEY").trim().length > 0;
}

export function stripeClient(): Stripe | null {
  if (!stripeEnabled()) return null;
  if (!client) {
    client = new Stripe(cfg("STRIPE_SECRET_KEY"), {
      apiVersion: "2024-06-20" as Stripe.LatestApiVersion,
      appInfo: { name: env.APP_NAME },
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    logger.info({ mode: cfg("STRIPE_SECRET_KEY").startsWith("sk_live") ? "live" : "test" }, "stripe client ready");
  }
  return client;
}

export function requireStripe(): Stripe {
  const stripe = stripeClient();
  if (!stripe) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY is empty)");
  return stripe;
}

export type StripeStatus = {
  enabled: boolean;
  mode: "live" | "test" | null;
  publishableKey: string | null;
  connectReady: boolean;
  webhookReady: boolean;
  currency: string;
  missing: string[];
};

export function stripeStatus(): StripeStatus {
  const missing: string[] = [];
  if (!cfg("STRIPE_SECRET_KEY")) missing.push("STRIPE_SECRET_KEY");
  if (!cfg("STRIPE_PUBLISHABLE_KEY")) missing.push("STRIPE_PUBLISHABLE_KEY");
  if (!cfg("STRIPE_WEBHOOK_SECRET")) missing.push("STRIPE_WEBHOOK_SECRET");

  return {
    enabled: stripeEnabled(),
    mode: stripeEnabled() ? (cfg("STRIPE_SECRET_KEY").startsWith("sk_live") ? "live" : "test") : null,
    publishableKey: cfg("STRIPE_PUBLISHABLE_KEY") || null,
    connectReady: stripeEnabled(),
    webhookReady: cfg("STRIPE_WEBHOOK_SECRET").trim().length > 0,
    currency: env.PAYMENT_CURRENCY,
    missing,
  };
}

/** Stripe works in the smallest currency unit; our prices are decimal amounts. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export function fromMinorUnits(amount: number): number {
  return Math.round(amount) / 100;
}
