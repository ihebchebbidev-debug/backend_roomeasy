import { Router } from "express";
import { z } from "zod";

import { apiError } from "@/core/errors.js";
import { asyncHandler, created, ok } from "@/core/http.js";
import { validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser, requireRole } from "@/middleware/auth.js";
import { ADMIN_ROLES, capabilitiesFor, hasCapability, isAdminRole, requireCapability } from "@/middleware/permissions.js";
import {
  adminOverview,
  adminReports,
  approveListing,
  createPayoutForHost,
  listListingsForReview,
  listPayouts,
  listUsers,
  markPayoutPaid,
  rejectListing,
  setListingSuspended,
  setUserSuspended,
  hostProfile,
} from "@/modules/admin/admin.repository.js";
import {
  LISTING_REJECTION_CODES,
  LISTING_REJECTION_REASONS,
  rejectionMessage,
} from "@/modules/admin/rejectionReasons.js";
import { listModerationLog, recordModeration } from "@/modules/admin/moderation.repository.js";
import { adminOperationsRouter } from "@/modules/admin/operations.routes.js";
import { adminCatalogRouter } from "@/modules/admin/catalog.routes.js";
import { grantRole, revokeRole } from "@/modules/accounts/accounts.repository.js";
import { listAllBookings } from "@/modules/bookings/bookings.repository.js";
import { bookingConversation } from "@/modules/messaging/messaging.repository.js";
import { deleteReview, listAllReviews, setReviewHidden } from "@/modules/reviews/reviews.repository.js";

export const adminRouter = Router();

/** Everything below requires an administrator role; each route then checks its own capability. */
adminRouter.use(requireRole(...ADMIN_ROLES));

/** Reports, verification, bans, commission, refunds, tickets, notifications. */
adminRouter.use(adminOperationsRouter);

/** Amenities, cities, content pages, translations, 2FA reset, Stripe identity sync. */
adminRouter.use(adminCatalogRouter);

/** The signed-in administrator: roles held and what they are allowed to do. */
adminRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const admin = currentUser(req);
    return ok(res, {
      userId: admin.userId,
      email: admin.email,
      roles: admin.roles,
      capabilities: capabilitiesFor(admin.roles),
    });
  }),
);

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- overview ----------------------------------------------------------------

adminRouter.get(
  "/overview",
  requireCapability("stats.read"),
  asyncHandler(async (_req, res) => ok(res, await adminOverview())),
);

adminRouter.get(
  "/reports",
  requireCapability("stats.read"),
  asyncHandler(async (req, res) => {
    const { months } = validateQuery(z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }), req);
    return ok(res, await adminReports(months));
  }),
);

// --- listing approvals -------------------------------------------------------

adminRouter.get(
  "/listings",
  requireCapability("listings.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({
        scope: z.enum(["pending", "published", "suspended", "all"]).default("pending"),
        search: z.string().trim().max(120).optional(),
      }),
      req,
    );
    const result = await listListingsForReview(input);
    return ok(res, result.items, { total: result.total, limit: input.limit, offset: input.offset });
  }),
);

const listingParams = z.object({ listingId: z.string().trim().min(1).max(140) });

adminRouter.post(
  "/listings/:listingId/approve",
  requireCapability("listings.moderate"),
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const listing = await approveListing(listingId);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "listing_approved",
      targetKind: "listing",
      targetId: listingId,
      metadata: { propertyId: listing.propertyId },
    });
    req.log.info({ listingId }, "listing approved");
    return ok(res, listing);
  }),
);

adminRouter.post(
  "/listings/:listingId/reject",
  requireCapability("listings.moderate"),
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const body = validateBody(
      z.object({
        // Moderators pick a standard reason; free text only adds detail.
        reasonCode: z.enum(LISTING_REJECTION_CODES).optional(),
        details: z.string().trim().max(600).optional(),
        reason: z.string().trim().min(5, "Tell the host why, in at least 5 characters.").max(600).optional(),
      }),
      req,
    );
    if (!body.reasonCode && !body.reason) {
      throw apiError("VALIDATION_FAILED", { message: "Pick a refusal reason." });
    }
    if (body.reasonCode === "other" && !body.details) {
      throw apiError("VALIDATION_FAILED", { message: "Explain the refusal when choosing \"Other\"." });
    }
    const reason = body.reasonCode ? rejectionMessage(body.reasonCode, body.details) : body.reason!;
    const listing = await rejectListing(listingId, reason);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "listing_rejected",
      targetKind: "listing",
      targetId: listingId,
      reason,
    });
    req.log.info({ listingId, reason }, "listing rejected");
    return ok(res, listing);
  }),
);

adminRouter.post(
  "/listings/:listingId/suspend",
  requireCapability("listings.moderate"),
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const { reason } = validateBody(z.object({ reason: z.string().trim().max(600).optional() }), req);
    const listing = await setListingSuspended(listingId, true);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "listing_suspended",
      targetKind: "listing",
      targetId: listingId,
      reason: reason ?? null,
    });
    return ok(res, listing);
  }),
);

adminRouter.post(
  "/listings/:listingId/restore",
  requireCapability("listings.moderate"),
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(listingParams, req);
    const listing = await setListingSuspended(listingId, false);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "listing_published",
      targetKind: "listing",
      targetId: listingId,
    });
    return ok(res, listing);
  }),
);

// --- users -------------------------------------------------------------------

const userParams = z.object({ userId: z.string().uuid("That is not a valid account id.") });

adminRouter.get(
  "/users",
  requireCapability("users.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({
        search: z.string().trim().max(120).optional(),
        role: z.enum(["guest", "host", "admin", "moderator", "support", "accounting"]).optional(),
        suspended: z
          .enum(["true", "false"])
          .optional()
          .transform((value) => (value === undefined ? undefined : value === "true")),
      }),
      req,
    );
    const result = await listUsers(input);
    return ok(res, result.items, { total: result.total, limit: input.limit, offset: input.offset });
  }),
);

/** The standard refusal reasons, so the back office and the API never drift apart. */
adminRouter.get(
  "/listing-rejection-reasons",
  asyncHandler(async (_req, res) => ok(res, LISTING_REJECTION_REASONS)),
);

/** One host, with their listings, bookings, revenue, reviews and documents. */
adminRouter.get(
  "/hosts/:userId",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(userParams, req);
    return ok(res, await hostProfile(userId));
  }),
);


adminRouter.post(
  "/users/:userId/suspend",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(userParams, req);
    const { reason, until } = validateBody(
      z.object({
        reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(600),
        // Omitted or null means the suspension has no end date.
        until: z.string().datetime().nullish(),
      }),
      req,
    );
    const admin = currentUser(req);
    const user = await setUserSuspended({ userId, suspended: true, reason, until, actingAdminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "user_suspended",
      targetKind: "user",
      targetId: userId,
      reason,
    });
    req.log.warn({ userId, reason }, "account suspended");
    return ok(res, user);
  }),
);

adminRouter.post(
  "/users/:userId/restore",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(userParams, req);
    const admin = currentUser(req);
    const user = await setUserSuspended({ userId, suspended: false, actingAdminId: admin.userId });
    await recordModeration({ adminId: admin.userId, action: "user_restored", targetKind: "user", targetId: userId });
    return ok(res, user);
  }),
);

const roleSchema = z.enum(["guest", "host", "admin", "moderator", "support", "accounting"]);

adminRouter.post(
  "/users/:userId/roles",
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(userParams, req);
    const { role } = validateBody(z.object({ role: roleSchema }), req);
    const admin = currentUser(req);
    // Handing out an administrator role is reserved to the super admin.
    const capability = isAdminRole(role) ? "admins.manage" : "users.manage";
    if (!hasCapability(admin.roles, capability)) {
      throw apiError("FORBIDDEN", { message: "Your administrator role does not allow this action." });
    }
    const account = await grantRole(userId, role);
    await recordModeration({
      adminId: admin.userId,
      action: "role_granted",
      targetKind: "user",
      targetId: userId,
      metadata: { role },
    });
    req.log.info({ userId, role }, "role granted");
    return ok(res, account);
  }),
);

adminRouter.delete(
  "/users/:userId/roles/:role",
  asyncHandler(async (req, res) => {
    const { userId, role } = validateParams(userParams.extend({ role: roleSchema }), req);
    const admin = currentUser(req);
    const capability = isAdminRole(role) ? "admins.manage" : "users.manage";
    if (!hasCapability(admin.roles, capability)) {
      throw apiError("FORBIDDEN", { message: "Your administrator role does not allow this action." });
    }
    if (userId === admin.userId && role === "admin") {
      return ok(res, { removed: false, message: "You cannot remove your own administrator role." });
    }
    await revokeRole(userId, role);
    await recordModeration({
      adminId: admin.userId,
      action: "role_revoked",
      targetKind: "user",
      targetId: userId,
      metadata: { role },
    });
    req.log.info({ userId, role }, "role revoked");
    return ok(res, { removed: true, userId, role });
  }),
);

// --- moderation --------------------------------------------------------------

adminRouter.get(
  "/moderation-log",
  requireCapability("audit.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(pagination, req);
    return ok(res, await listModerationLog(input));
  }),
);

adminRouter.get(
  "/reviews",
  requireCapability("listings.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(pagination.extend({ limit: z.coerce.number().int().min(1).max(200).default(100) }), req);
    return ok(res, await listAllReviews(input));
  }),
);

adminRouter.post(
  "/reviews/:reviewId/hide",
  requireCapability("reviews.moderate"),
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(z.object({ reviewId: z.string().trim().min(1).max(140) }), req);
    const { reason } = validateBody(
      z.object({ reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(600) }),
      req,
    );
    const admin = currentUser(req);
    const review = await setReviewHidden({ reviewId, hidden: true, adminId: admin.userId, reason });
    await recordModeration({
      adminId: admin.userId,
      action: "review_hidden",
      targetKind: "review",
      targetId: reviewId,
      reason,
    });
    return ok(res, review);
  }),
);

adminRouter.post(
  "/reviews/:reviewId/restore",
  requireCapability("reviews.moderate"),
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(z.object({ reviewId: z.string().trim().min(1).max(140) }), req);
    const admin = currentUser(req);
    const review = await setReviewHidden({ reviewId, hidden: false, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "review_restored",
      targetKind: "review",
      targetId: reviewId,
    });
    return ok(res, review);
  }),
);

adminRouter.delete(
  "/reviews/:reviewId",
  requireCapability("reviews.moderate"),
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(z.object({ reviewId: z.string().trim().min(1).max(140) }), req);
    const admin = currentUser(req);
    const removed = await deleteReview(reviewId);
    await recordModeration({
      adminId: admin.userId,
      action: "review_deleted",
      targetKind: "review",
      targetId: reviewId,
      reason: "Deleted from the admin back office.",
    });
    return ok(res, removed);
  }),
);

// --- bookings & payouts ------------------------------------------------------

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);

adminRouter.get(
  "/bookings",
  requireCapability("bookings.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({
        status: z.enum(["pending", "confirmed", "declined", "cancelled", "completed"]).optional(),
        search: z.string().trim().max(120).optional(),
        guest: z.string().trim().max(120).optional(),
        host: z.string().trim().max(120).optional(),
        listing: z.string().trim().max(160).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      }),
      req,
    );
    const result = await listAllBookings({
      limit: input.limit,
      offset: input.offset,
      search: input.search,
      guest: input.guest,
      host: input.host,
      listing: input.listing,
      from: input.from,
      to: input.to,
      status: input.status ? [input.status] : undefined,
    });
    return ok(res, result.items, { total: result.total, limit: input.limit, offset: input.offset });
  }),
);

/** Read-only traveller-host conversation shown on the reservation sheet. */
adminRouter.get(
  "/bookings/:bookingId/conversation",
  requireCapability("bookings.read"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(z.object({ bookingId: z.string().trim().min(1).max(140) }), req);
    return ok(res, await bookingConversation(bookingId));
  }),
);

adminRouter.get(
  "/payouts",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({
        hostId: z.string().uuid().optional(),
        status: z.enum(["paid", "scheduled"]).optional(),
      }),
      req,
    );
    const result = await listPayouts(input);
    return ok(res, result.items, { total: result.total, totalUsd: result.totalUsd });
  }),
);

adminRouter.post(
  "/payouts",
  requireCapability("finance.manage"),
  asyncHandler(async (req, res) => {
    const input = validateBody(
      z.object({
        hostId: z.string().uuid("Choose a host."),
        payoutDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.")
          .optional(),
      }),
      req,
    );
    const payout = await createPayoutForHost(input.hostId, input.payoutDate);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "payout_created",
      targetKind: "payout",
      targetId: payout.id,
      metadata: { hostId: input.hostId, amountUsd: payout.amountUsd },
    });
    req.log.info({ payoutId: payout.id, hostId: input.hostId, amountUsd: payout.amountUsd }, "payout created");
    return created(res, payout);
  }),
);

adminRouter.post(
  "/payouts/:payoutId/paid",
  requireCapability("finance.manage"),
  asyncHandler(async (req, res) => {
    const { payoutId } = validateParams(z.object({ payoutId: z.string().trim().min(1).max(140) }), req);
    const payout = await markPayoutPaid(payoutId);
    await recordModeration({
      adminId: currentUser(req).userId,
      action: "payout_paid",
      targetKind: "payout",
      targetId: payoutId,
    });
    req.log.info({ payoutId }, "payout marked as paid");
    return ok(res, payout);
  }),
);
