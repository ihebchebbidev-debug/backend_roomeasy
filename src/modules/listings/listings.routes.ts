import { isActivePropertyType } from "@/modules/admin/taxonomy.repository.js";
import { Router } from "express";
import { z } from "zod";

import { apiError } from "@/core/errors.js";
import { asyncHandler, noContent, ok } from "@/core/http.js";
import { isoDate, validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser, isAdmin, requireRole } from "@/middleware/auth.js";
import { ensureHostProfile } from "@/modules/host/host.repository.js";
import {
  calendarForProperty,
  clearCalendarNights,
  saveCalendarNights,
  setRangeBlocked,
} from "@/modules/listings/calendar.repository.js";
import {
  assertListingOwner,
  deleteListing,
  latestSubmission,
  listHostListings,
  listSubmissions,
  saveListing,
  setListingStatus,
  type ListingDraft,
} from "@/modules/listings/listings.repository.js";
import { findPropertyById } from "@/modules/properties/properties.repository.js";

export const listingsRouter = Router();

/** Every route here belongs to a host (or an admin acting on their behalf). */
listingsRouter.use(requireRole("host", "admin"));

/** Property types are managed by admins (table property_type); checked against the database on save. */
const propertyTypeId = z.string().trim().regex(/^[a-z0-9_-]{2,40}$/, "Choose a property type.");

/** Mirrors `listingDraftSchema` in the app so both sides reject the same payload. */
const draftSchema = z.object({
  propertyId: z.string().trim().max(120).default(""),
  listingId: z.string().trim().max(140).default(""),
  title: z.string().trim().min(4, "The title needs at least 4 characters.").max(120),
  category: propertyTypeId,
  summary: z.string().trim().max(300).default(""),
  description: z.string().trim().max(4000).default(""),
  location: z.object({
    city: z.string().trim().min(2, "Enter the city.").max(80),
    country: z.string().trim().min(2, "Enter the country.").max(80),
    postal: z.string().trim().max(16).default(""),
    neighbourhood: z.string().trim().max(120).default(""),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  }),
  capacity: z.object({
    guests: z.number().int().min(1).max(64),
    rooms: z.number().int().min(1).max(40),
    beds: z.number().int().min(1).max(64),
    baths: z.number().int().min(1).max(40),
    area: z.number().int().min(10).max(5000),
  }),
  amenities: z.array(z.string().trim().max(40)).max(32).default([]),
  equipment: z.array(z.string().trim().max(80)).max(200).default([]),
  // Photos arrive either as a URL or as an inline data: URL produced by the
  // host wizard when the host picks a file, so the limit has to fit an image.
  photos: z
    .array(z.string().trim().max(3_000_000))
    .max(10, "A listing can hold at most 10 photos.")
    .default([]),
  pricing: z.object({
    currency: z.enum(["EUR", "USD", "GBP", "CHF", "BRL"]).default("EUR"),
    nightlyUsd: z.number().min(10, "The nightly price starts at $10.").max(100_000),
    cleaningFeeUsd: z.number().min(0).max(100_000).default(0),
    minNights: z.number().int().min(1).max(365).default(1),
    longStay: z.object({
      enabled: z.boolean(),
      threshold: z.number().int().min(1).max(365),
      discount: z.number().min(0).max(90),
    }),
    mobile: z.object({ enabled: z.boolean(), discount: z.number().min(0).max(90) }),
  }),
  policies: z.object({
    cancellationPolicy: z.enum(["flexible", "moderate", "strict"]),
    houseRules: z.string().trim().max(2000).default(""),
    checkIn: z.string().trim().max(10).default(""),
    checkOut: z.string().trim().max(10).default(""),
    instantBook: z.boolean().default(false),
  }),
  status: z.enum(["draft", "published", "suspended"]).default("draft"),
});

const listingParams = z.object({ listingId: z.string().trim().min(1).max(140) });

/** The host's own listings, including drafts and suspended rows. */
listingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await listHostListings(currentUser(req).userId);
    return ok(res, items, { total: items.length });
  }),
);

/** Create or update from one wizard payload. */
listingsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const draft = validateBody(draftSchema, req) as ListingDraft;
    if (!(await isActivePropertyType(draft.category))) {
      throw apiError("VALIDATION_FAILED", { message: "This property type is not available.", details: { field: "category" } });
    }
    const user = currentUser(req);
    await ensureHostProfile(user.userId);

    const saved = await saveListing({
      draft,
      hostId: user.userId,
      actorId: user.userId,
      isAdmin: isAdmin(req),
    });

    req.log.info({ listingId: saved.listingId, status: saved.status }, "listing saved");
    return ok(res, saved);
  }),
);

/**
 * Several of the host's own stays in one call (instead of one request per
 * listing). Ids the caller does not own are silently left out.
 */
listingsRouter.get(
  "/batch",
  asyncHandler(async (req, res) => {
    const { ids } = validateQuery(z.object({ ids: z.string().max(8000) }), req);
    const wanted = [...new Set(ids.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 100);
    const caller = { userId: currentUser(req).userId, isAdmin: isAdmin(req) };
    const rows = await Promise.all(
      wanted.map(async (listingId) => {
        try {
          const owned = await assertListingOwner(listingId, caller);
          const property = await findPropertyById(owned.propertyId, { includeUnpublished: true });
          return property ? { listingId, property } : null;
        } catch {
          return null;
        }
      }),
    );
    return ok(res, rows.filter(Boolean));
  }),
);

/** The full stay record as guests will see it (host preview). */
listingsRouter.get(
  "/:listingId",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const owned = await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });
    const property = await findPropertyById(owned.propertyId, { includeUnpublished: true });
    return ok(res, { listing: owned, property, draft: await latestSubmission(listingId) });
  }),
);

listingsRouter.get(
  "/:listingId/history",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });
    return ok(res, await listSubmissions(listingId));
  }),
);

listingsRouter.patch(
  "/:listingId/status",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const body = validateBody(z.object({ status: z.enum(["draft", "published", "suspended"]) }), req);
    const owned = await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });

    // Publishing an unapproved listing is allowed, but the guest search only
    // shows approved rows — say so plainly instead of failing silently.
    const result = await setListingStatus(listingId, body.status);
    req.log.info({ listingId, status: body.status }, "listing status changed");

    return ok(res, {
      ...result,
      propertyId: owned.propertyId,
      visibleToGuests: result.status === "published" && result.approved,
      message:
        result.status === "published" && !result.approved
          ? "Published. An administrator must approve it before guests can see it."
          : undefined,
    });
  }),
);

listingsRouter.delete(
  "/:listingId",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });
    await deleteListing(listingId);
    req.log.info({ listingId }, "listing deleted");
    return noContent(res);
  }),
);

// ---------------------------------------------------------------------------
// Availability calendar
// ---------------------------------------------------------------------------

listingsRouter.get(
  "/:listingId/calendar",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const range = validateQuery(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req);
    const owned = await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });
    return ok(res, await calendarForProperty(owned.propertyId, range));
  }),
);

const nightSchema = z.object({
  night: isoDate,
  blocked: z.boolean().optional(),
  priceUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

listingsRouter.put(
  "/:listingId/calendar",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const body = validateBody(
      z
        .object({
          nights: z.array(nightSchema).max(400).optional(),
          range: z
            .object({ from: isoDate, to: isoDate, blocked: z.boolean(), note: z.string().trim().max(300).optional() })
            .optional(),
        })
        .refine((value) => value.nights?.length || value.range, "Send either `nights` or a `range` to change."),
      req,
    );

    const owned = await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });

    if (body.range && body.range.to <= body.range.from) {
      throw apiError("INVALID_DATES", {
        message: "The end of the range must be after its start.",
        issues: [{ field: "range.to", message: "Must be after range.from." }],
      });
    }

    const saved = body.range
      ? await setRangeBlocked(
          owned.propertyId,
          body.range.from,
          body.range.to,
          body.range.blocked,
          body.range.note ?? null,
        )
      : await saveCalendarNights(owned.propertyId, body.nights ?? []);

    req.log.info({ listingId, nights: saved.length }, "calendar updated");
    return ok(res, saved, { total: saved.length });
  }),
);

listingsRouter.delete(
  "/:listingId/calendar",
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const body = validateBody(z.object({ nights: z.array(isoDate).min(1).max(400) }), req);
    const owned = await assertListingOwner(listingId, { userId: currentUser(req).userId, isAdmin: isAdmin(req) });
    await clearCalendarNights(owned.propertyId, body.nights);
    return noContent(res);
  }),
);
