import { Router } from "express";
import { z } from "zod";

import { asyncHandler, ok } from "@/core/http.js";
import { validateBody } from "@/core/validate.js";
import { currentUser, requireRole } from "@/middleware/auth.js";
import { recordModeration } from "@/modules/admin/moderation.repository.js";
import { getPlatformSettings, updatePlatformSettings } from "@/modules/settings/settings.repository.js";
import {
  INTEGRATION_KEYS,
  integrationView,
  saveIntegrationConfig,
  type IntegrationKey,
} from "@/modules/settings/integration-config.js";
import { sendMail, verifyMailer } from "@/modules/notifications/mailer.js";
import { stripeClient, stripeStatus } from "@/modules/payments/stripe.client.js";

export const settingsRouter = Router();

const socialLinkField = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), "Use a full link starting with https://")
  .optional();

const integrationPatchSchema = z
  .object(Object.fromEntries(INTEGRATION_KEYS.map((k) => [k, z.string().max(2000).optional()])) as Record<IntegrationKey, z.ZodOptional<z.ZodString>>)
  .strict();

/** Admin: email + Stripe credentials (secrets masked). */
settingsRouter.get(
  "/admin/integrations",
  requireRole("admin"),
  asyncHandler(async (_req, res) => ok(res, integrationView())),
);

settingsRouter.put(
  "/admin/integrations",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const patch = validateBody(integrationPatchSchema, req) as Partial<Record<IntegrationKey, string>>;
    const adminId = currentUser(req).userId;
    await saveIntegrationConfig(patch, adminId);
    await recordModeration({
      adminId,
      action: "settings_updated",
      targetKind: "settings",
      targetId: "integrations",
      metadata: { keys: Object.keys(patch) },
    });
    return ok(res, integrationView());
  }),
);

settingsRouter.post(
  "/admin/integrations/test-email",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const to = z.object({ to: z.string().email() }).parse(req.body ?? {}).to;
    const check = await verifyMailer();
    if (!check.ok) return ok(res, check);
    try {
      const result = await sendMail({ to, subject: "Test email", text: "Your email settings work.", html: "<p>Your email settings work.</p>" });
      return ok(res, { ok: true, dryRun: result.dryRun });
    } catch (error) {
      return ok(res, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }),
);

settingsRouter.post(
  "/admin/integrations/test-stripe",
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const client = stripeClient();
    if (!client) return ok(res, { ok: false, error: "Stripe secret key missing." });
    try {
      const balance = await client.balance.retrieve();
      return ok(res, { ok: true, mode: stripeStatus().mode, currencies: balance.available.map((b) => b.currency) });
    } catch (error) {
      return ok(res, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }),
);

const settingsPatchSchema = z
  .object({
    serviceFeeRate: z.number().min(0).max(1).optional(),
    taxRate: z.number().min(0).max(1).optional(),
    commissionRate: z.number().min(0).max(50).optional(),
    weekend: z.number().min(0).max(90).optional(),
    longStay: z.number().min(0).max(90).optional(),
    lastMinute: z.number().min(0).max(90).optional(),
    socialLinks: z
      .object({
        instagram: socialLinkField,
        x: socialLinkField,
        facebook: socialLinkField,
        linkedin: socialLinkField,
        tiktok: socialLinkField,
        youtube: socialLinkField,
      })
      .strict()
      .optional(),
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
      socialLinks: settings.socialLinks,
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
