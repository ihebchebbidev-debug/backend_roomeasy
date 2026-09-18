import { daysBetween, today } from "@/core/dates.js";

export type CancellationPolicy = "flexible" | "moderate" | "strict";

/** Port of `src/lib/cancellation.ts :: refundShare`. */
export function refundShare(policy: CancellationPolicy, daysBeforeCheckIn: number): number {
  if (policy === "flexible") return daysBeforeCheckIn >= 1 ? 1 : 0;
  if (policy === "moderate") return daysBeforeCheckIn >= 5 ? 1 : 0.5;
  return 0;
}

export function refundFor(options: {
  policy: CancellationPolicy;
  checkIn: string;
  totalUsd: number;
  /** A host or admin cancellation always refunds the guest in full. */
  cancelledBy: "guest" | "host" | "admin" | "system";
}): { percent: number; amountUsd: number; daysBeforeCheckIn: number } {
  const daysBeforeCheckIn = Math.max(0, daysBetween(today(), options.checkIn));
  const share = options.cancelledBy === "guest" ? refundShare(options.policy, daysBeforeCheckIn) : 1;
  return {
    percent: Number((share * 100).toFixed(2)),
    // Whole dollars, exactly like the quote engine rounds every line it charges;
    // a cents-precise refund could never match a whole-dollar total.
    amountUsd: Math.round(options.totalUsd * share),
    daysBeforeCheckIn,
  };
}
