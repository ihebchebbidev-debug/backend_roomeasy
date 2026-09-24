import { Router } from "express";
import { z } from "zod";

import { apiError } from "@/core/errors.js";
import { asyncHandler, created, noContent, ok } from "@/core/http.js";
import { validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser } from "@/middleware/auth.js";
import { requireCapability } from "@/middleware/permissions.js";
import {
  amenityGroups,
  deleteCity,
  deletePage,
  deleteTranslation,
  importCitiesFromListings,
  listCities,
  listPages,
  listTranslations,
  publicPage,
  removeAmenity,
  saveCity,
  savePage,
  saveTranslation,
  upsertAmenity,
} from "@/modules/admin/catalog.repository.js";
import {
  deleteCountry,
  listCountries,
  listPropertyTypes,
  removePropertyType,
  saveCountry,
  savePropertyType,
} from "@/modules/admin/taxonomy.repository.js";
import { recordModeration } from "@/modules/admin/moderation.repository.js";
import { resetTwoFactor } from "@/modules/accounts/twoFactor.repository.js";
import { listEquipment } from "@/modules/equipment/equipment.repository.js";
import { hostIdForAccount, recordStripeIdentity } from "@/modules/payments/payments.repository.js";
import { requireStripe, stripeEnabled } from "@/modules/payments/stripe.client.js";
import { queryOne } from "@/db/query.js";

const LOCALES = ["en", "fr", "es", "de", "pt"] as const;
const locale = z.enum(LOCALES);

/* =============================================================== admin side */

export const adminCatalogRouter = Router();

// ---- amenities taxonomy
adminCatalogRouter.get(
  "/taxonomy/amenities",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { search, group } = validateQuery(
      z.object({ search: z.string().trim().max(80).optional(), group: z.string().trim().max(40).optional() }),
      req,
    );
    return ok(res, { items: await listEquipment({ search, group, includeInactive: true }), groups: await amenityGroups() });
  }),
);

adminCatalogRouter.put(
  "/taxonomy/amenities/:id",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().trim().regex(/^[a-z0-9_-]{2,80}$/, "Use lowercase letters, digits, - or _.") }), req);
    const body = validateBody(
      z.object({
        group: z.string().trim().min(1).max(40),
        labelEn: z.string().trim().min(1).max(120),
        labelFr: z.string().trim().min(1).max(120),
        labelEs: z.string().trim().max(120).default(""),
        labelDe: z.string().trim().max(120).default(""),
        labelPt: z.string().trim().max(120).default(""),
        paid: z.boolean().default(false),
        active: z.boolean().default(true),
      }),
      req,
    );
    const item = await upsertAmenity({ id, ...body });
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `amenity:${id}`,
      metadata: { after: body },
    });
    return ok(res, item);
  }),
);

adminCatalogRouter.delete(
  "/taxonomy/amenities/:id",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().trim().min(1).max(80) }), req);
    const result = await removeAmenity(id);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `amenity:${id}`,
      metadata: { removed: result.deleted, retired: !result.deleted },
    });
    return ok(res, result);
  }),
);

// ---- city taxonomy
const citySchema = z.object({
  name: z.string().trim().min(1).max(120),
  country: z.string().trim().max(80).default(""),
  active: z.boolean().default(true),
  featured: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});

adminCatalogRouter.get(
  "/taxonomy/cities",
  requireCapability("content.manage"),
  asyncHandler(async (_req, res) => ok(res, await listCities({ includeInactive: true }))),
);

adminCatalogRouter.post(
  "/taxonomy/cities",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const body = validateBody(citySchema, req);
    const city = await saveCity(body);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `city:${city.id}`,
      metadata: { after: body },
    });
    return created(res, city);
  }),
);

adminCatalogRouter.post(
  "/taxonomy/cities/import",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const added = await importCitiesFromListings();
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: "city:import",
      metadata: { added },
    });
    return ok(res, { added });
  }),
);

adminCatalogRouter.put(
  "/taxonomy/cities/:id",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().uuid() }), req);
    const body = validateBody(citySchema, req);
    const city = await saveCity({ id, ...body });
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `city:${id}`,
      metadata: { after: body },
    });
    return ok(res, city);
  }),
);

adminCatalogRouter.delete(
  "/taxonomy/cities/:id",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().uuid() }), req);
    await deleteCity(id);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `city:${id}`,
      metadata: { removed: true },
    });
    return noContent(res);
  }),
);

// ---- property types
const typeLabels = z.object({
  en: z.string().trim().min(1).max(80),
  fr: z.string().trim().max(80).default(""),
  es: z.string().trim().max(80).default(""),
  de: z.string().trim().max(80).default(""),
  pt: z.string().trim().max(80).default(""),
});

adminCatalogRouter.get(
  "/taxonomy/property-types",
  requireCapability("content.manage"),
  asyncHandler(async (_req, res) => ok(res, await listPropertyTypes({ includeInactive: true }))),
);

adminCatalogRouter.put(
  "/taxonomy/property-types/:id",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/, "Use lowercase letters, digits, - or _.") }), req);
    const body = validateBody(
      z.object({ labels: typeLabels, active: z.boolean().default(true), sortOrder: z.number().int().min(0).max(10000).default(0) }),
      req,
    );
    const item = await savePropertyType({ id, ...body });
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `property_type:${id}`,
      metadata: { after: body },
    });
    return ok(res, item);
  }),
);

adminCatalogRouter.delete(
  "/taxonomy/property-types/:id",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().trim().min(1).max(40) }), req);
    const result = await removePropertyType(id);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `property_type:${id}`,
      metadata: { removed: result.deleted, retired: !result.deleted },
    });
    return ok(res, result);
  }),
);

// ---- countries
const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use the 2-letter country code, e.g. FR.");

adminCatalogRouter.get(
  "/taxonomy/countries",
  requireCapability("content.manage"),
  asyncHandler(async (_req, res) => ok(res, await listCountries({ includeInactive: true }))),
);

adminCatalogRouter.put(
  "/taxonomy/countries/:code",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { code } = validateParams(z.object({ code: countryCode }), req);
    const body = validateBody(
      z.object({
        name: z.string().trim().min(1).max(80),
        active: z.boolean().default(true),
        sortOrder: z.number().int().min(0).max(10000).default(0),
      }),
      req,
    );
    const item = await saveCountry({ code, ...body });
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `country:${code}`,
      metadata: { after: body },
    });
    return ok(res, item);
  }),
);

adminCatalogRouter.delete(
  "/taxonomy/countries/:code",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const { code } = validateParams(z.object({ code: countryCode }), req);
    await deleteCountry(code);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "taxonomy_updated",
      targetKind: "settings",
      targetId: `country:${code}`,
      metadata: { removed: true },
    });
    return noContent(res);
  }),
);

// ---- content pages (CMS)
const slug = z.string().trim().regex(/^[a-z0-9-]{2,60}$/, "Use lowercase letters, digits and dashes.");

adminCatalogRouter.get(
  "/content/pages",
  requireCapability("content.manage"),
  asyncHandler(async (_req, res) => ok(res, await listPages())),
);

adminCatalogRouter.put(
  "/content/pages/:slug/:locale",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const params = validateParams(z.object({ slug, locale }), req);
    const body = validateBody(
      z.object({
        title: z.string().trim().min(1).max(200),
        body: z.string().max(100000),
        published: z.boolean().default(true),
      }),
      req,
    );
    const admin = currentUser(req);
    const page = await savePage({ ...params, ...body, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "content_updated",
      targetKind: "settings",
      targetId: `page:${params.slug}:${params.locale}`,
      metadata: { title: body.title, published: body.published, length: body.body.length },
    });
    return ok(res, page);
  }),
);

adminCatalogRouter.delete(
  "/content/pages/:slug/:locale",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const params = validateParams(z.object({ slug, locale }), req);
    await deletePage(params.slug, params.locale);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "content_updated",
      targetKind: "settings",
      targetId: `page:${params.slug}:${params.locale}`,
      metadata: { removed: true },
    });
    return noContent(res);
  }),
);

// ---- translation management
const translationKey = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,200}$/, "Use the dotted key, e.g. app.auth.signIn.");

adminCatalogRouter.get(
  "/content/translations",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const query = validateQuery(z.object({ locale: locale.optional() }), req);
    return ok(res, await listTranslations(query.locale));
  }),
);

adminCatalogRouter.put(
  "/content/translations/:locale",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const params = validateParams(z.object({ locale }), req);
    const body = validateBody(z.object({ key: translationKey, value: z.string().max(4000) }), req);
    const admin = currentUser(req);
    await saveTranslation({ locale: params.locale, key: body.key, value: body.value, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "translation_updated",
      targetKind: "settings",
      targetId: `translation:${params.locale}:${body.key}`,
      metadata: { after: body.value },
    });
    return ok(res, { locale: params.locale, key: body.key, value: body.value });
  }),
);

adminCatalogRouter.delete(
  "/content/translations/:locale",
  requireCapability("content.manage"),
  asyncHandler(async (req, res) => {
    const params = validateParams(z.object({ locale }), req);
    const body = validateQuery(z.object({ key: translationKey }), req);
    await deleteTranslation(params.locale, body.key);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "translation_updated",
      targetKind: "settings",
      targetId: `translation:${params.locale}:${body.key}`,
      metadata: { removed: true },
    });
    return noContent(res);
  }),
);

// ---- security: reset a colleague's two-step sign-in
adminCatalogRouter.post(
  "/users/:userId/2fa/reset",
  requireCapability("admins.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(z.object({ userId: z.string().uuid() }), req);
    await resetTwoFactor(userId);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "two_factor_reset",
      targetKind: "user",
      targetId: userId,
    });
    return ok(res, { reset: true });
  }),
);

// ---- identity: pull the latest verification state straight from Stripe
adminCatalogRouter.post(
  "/users/:userId/identity/sync",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(z.object({ userId: z.string().uuid() }), req);
    if (!stripeEnabled()) throw apiError("FORBIDDEN", { message: "Stripe is not configured on the server." });
    const row = await queryOne<{ stripe_account_id: string | null }>(
      "SELECT stripe_account_id FROM host_profile WHERE user_id = $1",
      [userId],
      { label: "catalog.identity.account" },
    );
    if (!row?.stripe_account_id) {
      throw apiError("NOT_FOUND", { message: "This host has not connected a Stripe account yet." });
    }
    const account = await requireStripe().accounts.retrieve(row.stripe_account_id);
    const hostId = (await hostIdForAccount(account.id)) ?? userId;
    const due = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])];
    const reported = (account as unknown as { individual?: { verification?: { status?: string } } }).individual
      ?.verification?.status;
    const status =
      reported === "verified" && due.length === 0
        ? "verified"
        : reported === "pending"
          ? "pending"
          : due.length
            ? "requirements_due"
            : account.details_submitted
              ? "pending"
              : "unverified";
    await recordStripeIdentity({ hostId, accountId: account.id, status, requirements: due });
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "identity_synced",
      targetKind: "user",
      targetId: userId,
      metadata: { stripeStatus: status, requirements: due },
    });
    return ok(res, { stripeStatus: status, requirements: due });
  }),
);

/* ============================================================== public side */

export const publicContentRouter = Router();

publicContentRouter.get(
  "/pages/:slug",
  asyncHandler(async (req, res) => {
    const params = validateParams(z.object({ slug }), req);
    const query = validateQuery(z.object({ locale: locale.default("en") }), req);
    const page = await publicPage(params.slug, query.locale);
    if (!page) throw apiError("NOT_FOUND");
    return ok(res, page);
  }),
);

publicContentRouter.get(
  "/translations/:locale",
  asyncHandler(async (req, res) => {
    const params = validateParams(z.object({ locale }), req);
    const rows = await listTranslations(params.locale);
    res.setHeader("Cache-Control", "public, max-age=60");
    return ok(res, Object.fromEntries(rows.map((row) => [row.key, row.value])));
  }),
);

publicContentRouter.get(
  "/property-types",
  asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    return ok(res, await listPropertyTypes({ includeInactive: false }));
  }),
);

publicContentRouter.get(
  "/countries",
  asyncHandler(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    return ok(res, await listCountries({ includeInactive: false }));
  }),
);

publicContentRouter.get(
  "/cities",
  asyncHandler(async (_req, res) => ok(res, await listCities({ includeInactive: false }))),
);
