import { Router } from "express";
import { z } from "zod";

import { asyncHandler, ok } from "@/core/http.js";
import { isoDate, validateParams, validateQuery } from "@/core/validate.js";
import { apiError } from "@/core/errors.js";
import { isAdmin } from "@/middleware/auth.js";
import {
  countByCategory,
  destinationCoords,
  findPropertyById,
  searchProperties,
  unavailablePropertyIds,
  type SearchFilters,
} from "@/modules/properties/properties.repository.js";
import { cachedCatalogue } from "@/core/catalogueCache.js";
import { listPropertyReviews } from "@/modules/reviews/reviews.repository.js";
import { calendarForProperty } from "@/modules/listings/calendar.repository.js";

export const propertiesRouter = Router();

const csv = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined,
  );

const searchQuerySchema = z.object({
  where: z.string().trim().max(120).optional(),
  category: z.string().trim().max(40).optional(),
  minPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  maxPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  beds: z.coerce.number().int().min(0).max(64).optional(),
  baths: z.coerce.number().int().min(0).max(40).optional(),
  rooms: z.coerce.number().int().min(0).max(40).optional(),
  guests: z.coerce.number().int().min(0).max(64).optional(),
  amenities: csv,
  equipment: csv,
  superhost: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : ["1", "true", "yes"].includes(value.toLowerCase()))),
  instantBook: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : ["1", "true", "yes"].includes(value.toLowerCase()))),
  freeCancellation: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : ["1", "true", "yes"].includes(value.toLowerCase()))),
  nights: z.coerce.number().int().min(1).max(365).optional(),
  bounds: z
    .string()
    .max(80)
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const parts = value.split(",").map(Number);
      const [south, west, north, east] = parts;
      if (
        parts.length !== 4 ||
        parts.some((n) => !Number.isFinite(n)) ||
        south! < -90 || north! > 90 || south! > north! ||
        west! < -180 || west! > 180 || east! < -180 || east! > 180
      ) {
        ctx.addIssue({ code: "custom", message: "bounds must be south,west,north,east" });
        return z.NEVER;
      }
      return { south: south!, west: west!, north: north!, east: east! };
    }),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(["recommended", "price-low", "price-high", "rating", "distance", "newest"]).default("recommended"),
  locale: z.enum(["en", "fr", "es", "de", "pt"]).default("en"),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

async function toFilters(input: z.infer<typeof searchQuerySchema>): Promise<SearchFilters> {
  if (input.from && input.to && input.to <= input.from) {
    throw apiError("INVALID_DATES", {
      issues: [{ field: "to", message: "Check-out must be after check-in." }],
      details: { from: input.from, to: input.to },
    });
  }
  if (input.minPrice !== undefined && input.maxPrice !== undefined && input.minPrice > input.maxPrice) {
    throw apiError("VALIDATION_FAILED", {
      message: "The minimum price cannot be above the maximum price.",
      issues: [{ field: "minPrice", message: "Must be lower than maxPrice." }],
    });
  }

  const filters: SearchFilters = { ...input };

  // "Sort by distance" needs a reference point: the searched destination.
  if (input.sort === "distance" && input.where) {
    const coords = await destinationCoords(input.where);
    if (coords) {
      filters.lat = coords.lat;
      filters.lng = coords.lng;
    }
  }

  return filters;
}

/** Guest search / landing grid. */
propertiesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const input = validateQuery(searchQuerySchema, req);
    const filters = await toFilters(input);
    const key = JSON.stringify(req.query);
    const { items, total } = await cachedCatalogue(key, () => searchProperties(filters));
    return ok(res, items, {
      total,
      limit: filters.limit,
      offset: filters.offset,
      hasMore: filters.offset + items.length < total,
    });
  }),
);

/** Counts per property type, used by the category chips. */
propertiesRouter.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const input = validateQuery(searchQuerySchema, req);
    return ok(res, await countByCategory(await toFilters(input)));
  }),
);

/**
 * Stays that are NOT free for a date range. Declared before "/:id" so the word
 * "unavailable" is not read as a stay id.
 */
propertiesRouter.get(
  "/unavailable",
  asyncHandler(async (req, res) => {
    const { from, to } = validateQuery(z.object({ from: isoDate, to: isoDate }), req);
    if (to <= from) {
      throw apiError("INVALID_DATES", {
        issues: [{ field: "to", message: "Check-out must be after check-in." }],
        details: { from, to },
      });
    }
    return ok(res, await unavailablePropertyIds(from, to));
  }),
);

const propertyParams = z.object({ id: z.string().trim().min(1).max(120) });

propertiesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = validateParams(propertyParams, req);
    const { locale } = validateQuery(z.object({ locale: z.enum(["en", "fr", "es", "de", "pt"]).default("en") }), req);
    // Admins (and the host through the host routes) may open unpublished rows.
    const property = await findPropertyById(id, { locale, includeUnpublished: isAdmin(req) });
    if (!property) {
      throw apiError("NOT_FOUND", { message: `No stay exists with the id "${id}".`, details: { propertyId: id } });
    }
    return ok(res, property);
  }),
);

propertiesRouter.get(
  "/:id/reviews",
  asyncHandler(async (req, res) => {
    const { id } = validateParams(propertyParams, req);
    const input = validateQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).max(100_000).default(0),
      }),
      req,
    );
    const { items, total } = await listPropertyReviews(id, { ...input, includeHidden: isAdmin(req) });
    return ok(res, items, { total, ...input });
  }),
);

/** Availability calendar for the date picker: blocked nights and price overrides. */
propertiesRouter.get(
  "/:id/calendar",
  asyncHandler(async (req, res) => {
    const { id } = validateParams(propertyParams, req);
    const input = validateQuery(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req);
    if (input.from && input.to && input.to <= input.from) {
      throw apiError("INVALID_DATES", { issues: [{ field: "to", message: "The end date must be after the start." }] });
    }
    return ok(res, await calendarForProperty(id, input));
  }),
);
