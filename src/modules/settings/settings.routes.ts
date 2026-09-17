import { Router } from "express";
import { z } from "zod";

import { asyncHandler, ok } from "@/core/http.js";
import { validateBody } from "@/core/validate.js";
import { currentUser, requireRole } from "@/middleware/auth.js";
import { recordModeration } from "@/modules/admin/moderation.repository.js";
import { getPlatformSettings, updatePlatformSettings } from "@/modules/settings/settings.repository.js";

export const settingsRouter = Router();

const settingsPatchSchema = z
  .object({
    serviceFeeRate: z.number().min(0).max(1).optional(),
    taxRate: z.number().min(0).max(1).optional(),
    commissionRate: z.number().min(0).max(50).optional(),
    weekend: z.number().min(0).max(90).optional(),
    longStay: z.number().min(0).max(90).optional(),
    lastMinute: z.number().min(0).max(90).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Send at least one setting to change.");

/** Public: the rates the app needs to display a price breakdown. */
settingsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const settings = await getPlatformSettings();
    return ok(res, {
      serviceFeeRate: settings.serviceFeeRate,
      taxRate: settings.taxRate,
      rateRules: settings.rateRules,
      updatedAt: settings.updatedAt,
    });
  }),
);

/** Admin: full settings including the platform commission. */
settingsRouter.get(
  "/admin",
  requireRole("admin"),
  asyncHandler(async (_req, res) => ok(res, await getPlatformSettings({ fresh: true }))),
);

settingsRouter.put(
  "/admin",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const patch = validateBody(settingsPatchSchema, req);
    const settings = await updatePlatformSettings(patch);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "settings_updated",
      targetKind: "settings",
      targetId: "platform",
      metadata: patch,
    });
    req.log.info({ patch }, "platform settings updated");
    return ok(res, settings);
  }),
);
