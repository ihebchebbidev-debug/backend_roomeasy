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
