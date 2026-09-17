import { Router } from "express";
import { z } from "zod";

import { asyncHandler, noContent, ok } from "@/core/http.js";
import { validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser, requireAuth } from "@/middleware/auth.js";
import {
  addFavorite,
  listFavoriteIds,
  listFavorites,
  removeFavorite,
  replaceFavorites,
} from "@/modules/favorites/favorites.repository.js";

export const favoritesRouter = Router();

favoritesRouter.use(requireAuth);

/** Ids only — what the heart icons need. */
favoritesRouter.get(
  "/ids",
  asyncHandler(async (req, res) => ok(res, await listFavoriteIds(currentUser(req).userId))),
);

/** Full stay cards for the "Saved" page. */
favoritesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { locale } = validateQuery(z.object({ locale: z.enum(["en", "fr", "es", "de", "pt"]).default("en") }), req);
    const items = await listFavorites(currentUser(req).userId, locale);
    return ok(res, items, { total: items.length });
  }),
);

favoritesRouter.put(
  "/:propertyId",
  asyncHandler(async (req, res) => {
    const { propertyId } = validateParams(z.object({ propertyId: z.string().trim().min(1).max(120) }), req);
    await addFavorite(currentUser(req).userId, propertyId);
    return ok(res, { propertyId, saved: true });
  }),
);

favoritesRouter.delete(
  "/:propertyId",
  asyncHandler(async (req, res) => {
    const { propertyId } = validateParams(z.object({ propertyId: z.string().trim().min(1).max(120) }), req);
    await removeFavorite(currentUser(req).userId, propertyId);
    return noContent(res);
  }),
);

/** Merge the guest's local list into the account after sign-in. */
favoritesRouter.post(
  "/sync",
  asyncHandler(async (req, res) => {
    const body = validateBody(z.object({ propertyIds: z.array(z.string().trim().min(1).max(120)).max(500) }), req);
    return ok(res, await replaceFavorites(currentUser(req).userId, body.propertyIds));
  }),
);
