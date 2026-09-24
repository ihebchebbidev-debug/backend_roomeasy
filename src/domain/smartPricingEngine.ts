/**
 * Smart automatic pricing engine — pure, deterministic, no I/O.
 *
 * This file is intentionally duplicated byte-for-byte (module boilerplate
 * aside) at:
 *   - nodejs_backend/src/domain/smartPricingEngine.ts (server — charges the guest)
 *   - src/lib/smartPricingEngine.ts                    (client — shows the preview)
 * The two projects compile independently (different tsconfig roots), so a
 * single shared import is not possible; `npm run pricing:parity` (see
 * scripts/pricing-parity.ts) runs both copies against the same fixtures and
 * fails the build if they ever disagree. Keep any change mirrored in both
 * files.
 *
 * ---------------------------------------------------------------------------
 * Rule precedence (highest to lowest), documented per the client spec:
 *
 *   1. Manual calendar override  — the host set an exact price for the night.
 *      When present, every other per-night rule below is skipped; only the
 *      floor/ceiling clamp still applies.
 *   2. Seasonal period           — a date range with a +/- % adjustment.
 *   3. Weekend                   — Friday/Saturday night surcharge.
 *   4. Occupancy                 — raises the price when the calendar is
 *      filling up over the next N days, lowers it when it is empty.
 *   5. Lead time                 — early-bird discount far in advance, or a
 *      last-minute discount close to check-in.
 *   6. Gap night                 — discount for a short, hard-to-sell gap
 *      between two other bookings.
 *
 * Rules 2-6 are cumulative percentage adjustments applied in that fixed
 * order to the running nightly price (so e.g. a weekend night in high season
 * stacks both effects). After all per-night rules, the result is clamped to
 * [floorUsd, ceilingUsd].
 *
 * Stay-level discounts (long-stay, mobile-booking) are applied once, on the
 * summed nightly subtotal, by the caller — they are not part of this
 * per-night engine (see `domain/pricing.ts` / `lib/pricing.ts`).
 */

export type SeasonalPeriod = {
  id: string;
  label: string;
  /** ISO date, inclusive. */
  startDate: string;
  /** ISO date, inclusive. */
  endDate: string;
  /** Percent adjustment, positive (uplift) or negative (discount). */
  percent: number;
  enabled: boolean;
};

export type SmartPricingRules = {
  weekend: { enabled: boolean; percent: number };
  seasonal: SeasonalPeriod[];
  leadTime: {
    /** Discount applied when the check-in is at least `days` away. */
    earlyBird: { enabled: boolean; days: number; percent: number };
    /** Discount applied when the check-in is within `days`. */
    lastMinute: { enabled: boolean; days: number; percent: number };
  };
  occupancy: {
    enabled: boolean;
    /** How many upcoming days the occupancy rate is measured over. */
    windowDays: number;
    /** Occupancy % at/above which the high-demand adjustment applies. */
    highThreshold: number;
    highPercent: number;
    /** Occupancy % at/below which the low-demand adjustment applies. */
    lowThreshold: number;
    lowPercent: number;
  };
  gapNight: {
    enabled: boolean;
    /** A free run of this many nights or fewer, boxed in by bookings, is a "gap". */
    maxGapNights: number;
    percent: number;
    /** Also allow the stay's minimum-nights rule to be bypassed for that gap. */
    allowShorterMinStay: boolean;
  };
  /** Absolute floor/ceiling in USD, applied to every night after all rules. */
  floorUsd: number | null;
  ceilingUsd: number | null;
};

export function defaultSmartPricingRules(): SmartPricingRules {
  return {
    weekend: { enabled: false, percent: 15 },
    seasonal: [],
    leadTime: {
      earlyBird: { enabled: false, days: 30, percent: 10 },
      lastMinute: { enabled: false, days: 3, percent: 15 },
    },
    occupancy: {
      enabled: false,
      windowDays: 30,
      highThreshold: 70,
      highPercent: 10,
      lowThreshold: 20,
      lowPercent: -10,
    },
    gapNight: { enabled: false, maxGapNights: 1, percent: 20, allowShorterMinStay: false },
    floorUsd: null,
    ceilingUsd: null,
  };
}

export type RuleId =
  | "override"
  | "seasonal"
  | "weekend"
  | "occupancyHigh"
  | "occupancyLow"
  | "leadTimeEarlyBird"
  | "leadTimeLastMinute"
  | "gapNight"
  | "floor"
  | "ceiling";

export type AppliedRule = {
  rule: RuleId;
  /** Human-readable extra detail, e.g. the seasonal period's label. */
  label?: string;
  /** Percent adjustment this rule applied, when it is percentage-based. */
  percent?: number;
  /** Resulting nightly price right after this rule, in USD. */
  priceAfter: number;
};

export type NightContext = {
  /** ISO date of the night being priced. */
  date: string;
  /** The listing's plain nightly rate before any rule. */
  basePrice: number;
  /** Host-set exact price for this night, if any (from the calendar). */
  overridePrice: number | null;
  /** Days between "now" and this night's check-in date. Negative = past. */
  daysAhead: number;
  /** Occupancy % of the configured window as of the quote date, or null if unknown. */
  occupancyPercent: number | null;
  /** True when this night is a short, isolated gap between two bookings. */
  isGapNight: boolean;
};

export type NightPriceResult = {
  date: string;
  basePrice: number;
  finalPrice: number;
  applied: AppliedRule[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isWeekendNight(date: string): boolean {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6; // Friday and Saturday nights
}

function findSeasonalPeriod(rules: SmartPricingRules, date: string): SeasonalPeriod | null {
  const matches = rules.seasonal.filter((period) => period.enabled && date >= period.startDate && date <= period.endDate);
  if (!matches.length) return null;
  // Deterministic tie-break: the most specific (shortest) period wins; ties
  // broken by declaration order.
  return matches.reduce((best, period) => {
    const bestLength = daysDiff(best.startDate, best.endDate);
    const length = daysDiff(period.startDate, period.endDate);
    return length < bestLength ? period : best;
  });
}

function daysDiff(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/** Prices one night, applying every rule in the documented precedence order. */
export function computeNightPrice(rules: SmartPricingRules, ctx: NightContext): NightPriceResult {
  const applied: AppliedRule[] = [];
  let price = ctx.basePrice;

  if (ctx.overridePrice !== null) {
    price = ctx.overridePrice;
    applied.push({ rule: "override", priceAfter: round2(price) });
  } else {
    const season = findSeasonalPeriod(rules, ctx.date);
    if (season) {
      price = price * (1 + season.percent / 100);
      applied.push({ rule: "seasonal", label: season.label, percent: season.percent, priceAfter: round2(price) });
    }

    if (rules.weekend.enabled && isWeekendNight(ctx.date)) {
      price = price * (1 + rules.weekend.percent / 100);
      applied.push({ rule: "weekend", percent: rules.weekend.percent, priceAfter: round2(price) });
    }

    if (rules.occupancy.enabled && ctx.occupancyPercent !== null) {
      if (ctx.occupancyPercent >= rules.occupancy.highThreshold) {
        price = price * (1 + rules.occupancy.highPercent / 100);
        applied.push({ rule: "occupancyHigh", percent: rules.occupancy.highPercent, priceAfter: round2(price) });
      } else if (ctx.occupancyPercent <= rules.occupancy.lowThreshold) {
        price = price * (1 + rules.occupancy.lowPercent / 100);
        applied.push({ rule: "occupancyLow", percent: rules.occupancy.lowPercent, priceAfter: round2(price) });
      }
    }

    if (rules.leadTime.lastMinute.enabled && ctx.daysAhead >= 0 && ctx.daysAhead <= rules.leadTime.lastMinute.days) {
      price = price * (1 - rules.leadTime.lastMinute.percent / 100);
      applied.push({ rule: "leadTimeLastMinute", percent: -rules.leadTime.lastMinute.percent, priceAfter: round2(price) });
    } else if (rules.leadTime.earlyBird.enabled && ctx.daysAhead >= rules.leadTime.earlyBird.days) {
      price = price * (1 - rules.leadTime.earlyBird.percent / 100);
      applied.push({ rule: "leadTimeEarlyBird", percent: -rules.leadTime.earlyBird.percent, priceAfter: round2(price) });
    }

    if (rules.gapNight.enabled && ctx.isGapNight) {
      price = price * (1 - rules.gapNight.percent / 100);
      applied.push({ rule: "gapNight", percent: -rules.gapNight.percent, priceAfter: round2(price) });
    }
  }

  if (rules.floorUsd !== null && price < rules.floorUsd) {
    price = rules.floorUsd;
    applied.push({ rule: "floor", priceAfter: round2(price) });
  }
  if (rules.ceilingUsd !== null && price > rules.ceilingUsd) {
    price = rules.ceilingUsd;
    applied.push({ rule: "ceiling", priceAfter: round2(price) });
  }

  return { date: ctx.date, basePrice: ctx.basePrice, finalPrice: round2(Math.max(0, price)), applied };
}

export function computeSmartPricing(rules: SmartPricingRules, nights: NightContext[]): NightPriceResult[] {
  return nights.map((ctx) => computeNightPrice(rules, ctx));
}
