import { Router } from "express";
import { z } from "zod";

import { asyncHandler, created, noContent, ok } from "@/core/http.js";
import { validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { email as emailField } from "@/core/validate.js";
import { currentUser, requireRole } from "@/middleware/auth.js";
import {
  addTeamMember,
  ensureHostProfile,
  findHostProfile,
  hostDashboard,
  hostEarningsByMonth,
  listTeamMembers,
  removeTeamMember,
  setPayoutOnboarding,
  updateHostProfile,
} from "@/modules/host/host.repository.js";
import { listPayouts } from "@/modules/admin/admin.repository.js";
import { getHostRateRules, saveHostRateRules } from "@/modules/settings/settings.repository.js";
import { apiError } from "@/core/errors.js";
import { addDaysIso, today as todayIso } from "@/modules/host/smartPricingDates.js";
import { query, queryOne } from "@/db/query.js";
import { computeNightPrice } from "@/domain/smartPricingEngine.js";
import { normalizeSmartRules } from "@/domain/smartPricingRules.js";

export const hostRouter = Router();

/** The whole host area needs the host role (admins may inspect it too). */
hostRouter.use(requireRole("host", "admin"));

// --- profile -----------------------------------------------------------------

hostRouter.get(
  "/profile",
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const profile = (await findHostProfile(user.userId)) ?? (await ensureHostProfile(user.userId));
    return ok(res, profile);
  }),
);

hostRouter.patch(
  "/profile",
  asyncHandler(async (req, res) => {
    const patch = validateBody(
      z
        .object({
          displayName: z.string().trim().min(2, "Enter a display name.").max(120).optional(),
          bio: z.string().trim().max(2000).optional(),
          hostingSince: z
            .number()
            .int()
            .min(1970, "That year is too far in the past.")
            .max(new Date().getUTCFullYear())
            .optional(),
        })
        .refine((value) => Object.keys(value).length > 0, "Send at least one field to change."),
      req,
    );
    return ok(res, await updateHostProfile(currentUser(req).userId, patch));
  }),
);

// --- dashboard ---------------------------------------------------------------

hostRouter.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const { window } = validateQuery(z.object({ window: z.coerce.number().int().min(7).max(365).default(90) }), req);
    return ok(res, await hostDashboard(currentUser(req).userId, window));
  }),
);

hostRouter.get(
  "/earnings",
  asyncHandler(async (req, res) => {
    const { months } = validateQuery(z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }), req);
    return ok(res, await hostEarningsByMonth(currentUser(req).userId, months));
  }),
);

// --- payouts -----------------------------------------------------------------

hostRouter.post(
  "/payouts/onboarding",
  asyncHandler(async (req, res) => {
    const input = validateBody(
      z.object({
        onboarded: z.boolean().default(true),
        reference: z.string().trim().max(120).optional(),
      }),
      req,
    );
    const profile = await setPayoutOnboarding(currentUser(req).userId, input);
    req.log.info({ onboarded: profile.payoutsOnboarded }, "payout onboarding updated");
    return ok(res, profile);
  }),
);

hostRouter.get(
  "/payouts",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        status: z.enum(["paid", "scheduled"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req,
    );
    const result = await listPayouts({ ...input, hostId: currentUser(req).userId });
    return ok(res, result.items, { total: result.total, totalUsd: result.totalUsd });
  }),
);

// --- pricing rules -----------------------------------------------------------

hostRouter.get(
  "/rate-rules",
  asyncHandler(async (req, res) => ok(res, await getHostRateRules(currentUser(req).userId))),
);

hostRouter.put(
  "/rate-rules",
  asyncHandler(async (req, res) => {
    const rules = validateBody(
      z.object({
        weekend: z.number().min(0, "A surcharge cannot be negative.").max(90),
        longStay: z.number().min(0).max(90),
        lastMinute: z.number().min(0).max(90),
      }),
      req,
    );
    return ok(res, await saveHostRateRules(currentUser(req).userId, rules));
  }),
);

// --- smart pricing ----------------------------------------------------------

const seasonalSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().max(80),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  percent: z.number().min(-90).max(300),
  enabled: z.boolean(),
});

const smartRulesSchema = z.object({
  weekend: z.object({ enabled: z.boolean(), percent: z.number().min(-90).max(300) }),
  seasonal: z.array(seasonalSchema).max(50),
  leadTime: z.object({
    earlyBird: z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(730), percent: z.number().min(0).max(90) }),
    lastMinute: z.object({ enabled: z.boolean(), days: z.number().int().min(0).max(60), percent: z.number().min(0).max(90) }),
  }),
  occupancy: z.object({
    enabled: z.boolean(),
    windowDays: z.number().int().min(1).max(365),
    highThreshold: z.number().min(0).max(100),
    highPercent: z.number().min(-90).max(300),
    lowThreshold: z.number().min(0).max(100),
    lowPercent: z.number().min(-90).max(300),
  }),
  gapNight: z.object({
    enabled: z.boolean(),
    maxGapNights: z.number().int().min(1).max(7),
    percent: z.number().min(0).max(90),
    allowShorterMinStay: z.boolean(),
  }),
  floorUsd: z.number().min(0).nullable(),
  ceilingUsd: z.number().min(0).nullable(),
});

async function ownedListing(req: Parameters<typeof currentUser>[0], propertyId: string) {
  const user = currentUser(req);
  const row = await queryOne<{ host_id: string | null; nightly_usd: string; smart_pricing_rules: unknown }>(
    `SELECT p.host_id, l.nightly_usd, l.smart_pricing_rules
       FROM property p JOIN listing l ON l.property_id = p.id WHERE p.id = $1`,
    [propertyId],
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That listing does not exist." });
  if (row.host_id !== user.userId && !user.roles.includes("admin")) {
    throw apiError("FORBIDDEN", { message: "This listing belongs to another host." });
  }
  return row;
}

hostRouter.get(
  "/listings/:propertyId/smart-pricing",
  asyncHandler(async (req, res) => {
    const { propertyId } = validateParams(z.object({ propertyId: z.string().min(1) }), req);
    const row = await ownedListing(req, propertyId);
    return ok(res, { rules: normalizeSmartRules(row.smart_pricing_rules), basePrice: Number(row.nightly_usd) });
  }),
);

hostRouter.put(
  "/listings/:propertyId/smart-pricing",
  asyncHandler(async (req, res) => {
    const { propertyId } = validateParams(z.object({ propertyId: z.string().min(1) }), req);
    await ownedListing(req, propertyId);
    const rules = validateBody(smartRulesSchema, req);
    if (rules.floorUsd !== null && rules.ceilingUsd !== null && rules.floorUsd > rules.ceilingUsd) {
      throw apiError("VALIDATION_FAILED", { message: "The minimum price cannot be above the maximum price." });
    }
    await query("UPDATE listing SET smart_pricing_rules = $2::jsonb WHERE property_id = $1", [
      propertyId,
      JSON.stringify(rules),
    ]);
    return ok(res, { rules: normalizeSmartRules(rules) });
  }),
);

/** Preview of the next N nights with a given (unsaved) rule set. */
hostRouter.post(
  "/listings/:propertyId/smart-pricing/preview",
  asyncHandler(async (req, res) => {
    const { propertyId } = validateParams(z.object({ propertyId: z.string().min(1) }), req);
    const row = await ownedListing(req, propertyId);
    const body = validateBody(z.object({ rules: smartRulesSchema, days: z.number().int().min(1).max(120).default(60) }), req);
    const rules = normalizeSmartRules(body.rules);
    const start = todayIso();
    const end = addDaysIso(start, body.days);
    const overrides = await query<{ night: string; price_usd: string | null }>(
      `SELECT night::text AS night, price_usd FROM calendar_night
        WHERE property_id = $1 AND night >= $2::date AND night < $3::date AND price_usd IS NOT NULL`,
      [propertyId, start, end],
    );
    const overrideMap = new Map(overrides.map((o) => [o.night, Number(o.price_usd)]));
    let occupancyPercent: number | null = null;
    if (rules.occupancy.enabled) {
      const window = rules.occupancy.windowDays;
      const occ = await queryOne<{ taken: string }>(
        `SELECT count(DISTINCT d)::text AS taken
           FROM booking b, generate_series(CURRENT_DATE, CURRENT_DATE + ($2::int - 1), interval '1 day') d
          WHERE b.property_id = $1 AND b.status IN ('pending','confirmed') AND d >= b.check_in AND d < b.check_out`,
        [propertyId, window],
      );
      occupancyPercent = Math.round((Number(occ?.taken ?? 0) / window) * 100);
    }
    const nights = Array.from({ length: body.days }, (_, i) => {
      const date = addDaysIso(start, i);
      return computeNightPrice(rules, {
        date,
        basePrice: Number(row.nightly_usd),
        overridePrice: overrideMap.get(date) ?? null,
        daysAhead: i,
        occupancyPercent,
        isGapNight: false,
      });
    });
    return ok(res, { occupancyPercent, nights });
  }),
);

// --- team --------------------------------------------------------------------

hostRouter.get(
  "/team",
  asyncHandler(async (req, res) => ok(res, await listTeamMembers(currentUser(req).userId))),
);

hostRouter.post(
  "/team",
  asyncHandler(async (req, res) => {
    const input = validateBody(
      z.object({
        fullName: z.string().trim().min(2, "Enter the person's name.").max(120),
        email: emailField,
        scopes: z
          .array(z.enum(["calendar", "messaging"]))
          .min(1, "Give the member at least one permission.")
          .default(["messaging"]),
      }),
      req,
    );
    const member = await addTeamMember({ hostId: currentUser(req).userId, ...input });
    req.log.info({ memberId: member.id }, "team member added");
    return created(res, member);
  }),
);

hostRouter.delete(
  "/team/:memberId",
  asyncHandler(async (req, res) => {
    const { memberId } = validateParams(z.object({ memberId: z.string().trim().min(1).max(140) }), req);
    await removeTeamMember(currentUser(req).userId, memberId);
    return noContent(res);
  }),
);
