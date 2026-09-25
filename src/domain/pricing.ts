import { isWeekendNight, stayNights, today } from "@/core/dates.js";
import { computeNightPrice, type NightPriceResult, type SmartPricingRules } from "@/domain/smartPricingEngine.js";

/**
 * The authoritative quote engine — a direct port of `src/lib/pricing.ts` so a
 * price shown in the app always equals the price the server charges.
 *
 * Two documented differences from the front-end mock:
 *  1. the cleaning fee is a real line and is added to the total;
 *  2. the `weekend` rate rule is returned as `weekendSurcharge` but is NOT
 *     applied, exactly like the front-end, which never used it. Set
 *     `applyWeekend: true` to switch it on once the client confirms the rule.
 */

export type DiscountKind = "longStay" | "mobile" | "lastMinute";

export type PriceLine = { id: DiscountKind; percent: number; amount: number };

export type PriceBreakdown = {
  /** The listing's own currency; every amount below is in it. */
  currency: string;
  nightly: number;
  nights: number;
  baseSubtotal: number;
  discounts: PriceLine[];
  subtotal: number;
  cleaningFee: number;
  serviceFee: number;
  taxes: number;
  total: number;
  /** Informational: what the weekend rule would add if it were enabled. */
  weekendSurcharge: number;
  /** Per-night explanation when smart pricing is active. */
  nightsDetail?: NightPriceResult[];
};

export type QuoteContext = {
  /** Listing currency (defaults to EUR). */
  currency?: string;
  from: string;
  to: string;
  nightlyUsd: number;
  cleaningFeeUsd: number;
  /** ISO date → price override / blocked flag. */
  calendar: Record<string, { blocked: boolean; priceUsd: number | null }>;
  longStay: { enabled: boolean; threshold: number; discount: number };
  mobile: { enabled: boolean; discount: number };
  rateRules: { weekend: number; longStay: number; lastMinute: number };
  serviceFeeRate: number;
  taxRate: number;
  isMobile: boolean;
  applyWeekend?: boolean;
  /** Host smart-pricing rules; when any rule is on, nightly prices come from the engine. */
  smart?: { rules: SmartPricingRules; occupancyPercent: number | null; gapNights: Set<string> } | null;
};

export function smartRulesActive(rules: SmartPricingRules): boolean {
  return (
    rules.weekend.enabled ||
    rules.seasonal.some((period) => period.enabled) ||
    rules.leadTime.earlyBird.enabled ||
    rules.leadTime.lastMinute.enabled ||
    rules.occupancy.enabled ||
    rules.gapNight.enabled ||
    rules.floorUsd !== null ||
    rules.ceilingUsd !== null
  );
}

const round = (value: number) => Math.round(value);

export function computeQuote(context: QuoteContext): PriceBreakdown {
  const nights = stayNights(context.from, context.to);

  if (context.smart && smartRulesActive(context.smart.rules)) {
    return computeSmartQuote(context, nights, context.smart);
  }

  const baseSubtotal = nights.reduce((sum, night) => {
    const override = context.calendar[night]?.priceUsd;
    return sum + (override ?? context.nightlyUsd);
  }, 0);

  const weekendNights = nights.filter(isWeekendNight);
  const weekendSurcharge =
    context.rateRules.weekend > 0
      ? round(
          weekendNights.reduce((sum, night) => {
            const nightly = context.calendar[night]?.priceUsd ?? context.nightlyUsd;
            return sum + (nightly * context.rateRules.weekend) / 100;
          }, 0),
        )
      : 0;

  const chargedBase = context.applyWeekend ? baseSubtotal + weekendSurcharge : baseSubtotal;

  const discounts: PriceLine[] = [];

  if (context.longStay.enabled && nights.length >= context.longStay.threshold && context.longStay.discount > 0) {
    discounts.push({
      id: "longStay",
      percent: context.longStay.discount,
      amount: round((chargedBase * context.longStay.discount) / 100),
    });
  }

  if (context.isMobile && context.mobile.enabled && context.mobile.discount > 0) {
    discounts.push({
      id: "mobile",
      percent: context.mobile.discount,
      amount: round((chargedBase * context.mobile.discount) / 100),
    });
  }

  if (context.rateRules.lastMinute > 0) {
    const daysAhead =
      (new Date(`${context.from}T00:00:00Z`).getTime() - new Date(`${today()}T00:00:00Z`).getTime()) / 86_400_000;
    if (daysAhead >= 0 && daysAhead <= 7) {
      discounts.push({
        id: "lastMinute",
        percent: context.rateRules.lastMinute,
        amount: round((chargedBase * context.rateRules.lastMinute) / 100),
      });
    }
  }

  const subtotal = Math.max(0, chargedBase - discounts.reduce((sum, line) => sum + line.amount, 0));
  const cleaningFee = round(context.cleaningFeeUsd);
  const serviceFee = round(subtotal * context.serviceFeeRate);
  const taxes = round(subtotal * context.taxRate);

  return {
    currency: context.currency ?? "EUR",
    nightly: context.nightlyUsd,
    nights: nights.length,
    baseSubtotal: chargedBase,
    discounts,
    subtotal,
    cleaningFee,
    serviceFee,
    taxes,
    total: subtotal + cleaningFee + serviceFee + taxes,
    weekendSurcharge,
  };
}

function computeSmartQuote(
  context: QuoteContext,
  nights: string[],
  smart: NonNullable<QuoteContext["smart"]>,
): PriceBreakdown {
  const todayMs = new Date(`${today()}T00:00:00Z`).getTime();
  const nightsDetail = nights.map((night) =>
    computeNightPrice(smart.rules, {
      date: night,
      basePrice: context.nightlyUsd,
      overridePrice: context.calendar[night]?.priceUsd ?? null,
      daysAhead: Math.round((new Date(`${context.from}T00:00:00Z`).getTime() - todayMs) / 86_400_000),
      occupancyPercent: smart.occupancyPercent,
      isGapNight: smart.gapNights.has(night),
    }),
  );
  const chargedBase = round(nightsDetail.reduce((sum, night) => sum + night.finalPrice, 0));

  const discounts: PriceLine[] = [];
  if (context.longStay.enabled && nights.length >= context.longStay.threshold && context.longStay.discount > 0) {
    discounts.push({ id: "longStay", percent: context.longStay.discount, amount: round((chargedBase * context.longStay.discount) / 100) });
  }
  if (context.isMobile && context.mobile.enabled && context.mobile.discount > 0) {
    discounts.push({ id: "mobile", percent: context.mobile.discount, amount: round((chargedBase * context.mobile.discount) / 100) });
  }

  const subtotal = Math.max(0, chargedBase - discounts.reduce((sum, line) => sum + line.amount, 0));
  const cleaningFee = round(context.cleaningFeeUsd);
  const serviceFee = round(subtotal * context.serviceFeeRate);
  const taxes = round(subtotal * context.taxRate);
  return {
    currency: context.currency ?? "EUR",
    nightly: nights.length ? round(chargedBase / nights.length) : context.nightlyUsd,
    nights: nights.length,
    baseSubtotal: chargedBase,
    discounts,
    subtotal,
    cleaningFee,
    serviceFee,
    taxes,
    total: subtotal + cleaningFee + serviceFee + taxes,
    weekendSurcharge: 0,
    nightsDetail,
  };
}
