import { defaultSmartPricingRules, type SmartPricingRules } from "@/domain/smartPricingEngine.js";

/** Fills a stored (possibly partial) rule set with defaults so the engine never sees holes. */
export function normalizeSmartRules(raw: unknown): SmartPricingRules {
  const base = defaultSmartPricingRules();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<SmartPricingRules>;
  return {
    weekend: { ...base.weekend, ...(r.weekend ?? {}) },
    seasonal: Array.isArray(r.seasonal) ? r.seasonal : [],
    leadTime: {
      earlyBird: { ...base.leadTime.earlyBird, ...(r.leadTime?.earlyBird ?? {}) },
      lastMinute: { ...base.leadTime.lastMinute, ...(r.leadTime?.lastMinute ?? {}) },
    },
    occupancy: { ...base.occupancy, ...(r.occupancy ?? {}) },
    gapNight: { ...base.gapNight, ...(r.gapNight ?? {}) },
    floorUsd: typeof r.floorUsd === "number" ? r.floorUsd : null,
    ceilingUsd: typeof r.ceilingUsd === "number" ? r.ceilingUsd : null,
  };
}
