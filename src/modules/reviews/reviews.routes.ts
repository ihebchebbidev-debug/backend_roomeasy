import { Router } from "express";
import { z } from "zod";

import { asyncHandler, created, ok } from "@/core/http.js";
import { validateBody, validateParams } from "@/core/validate.js";
import { currentUser, isAdmin, requireAuth } from "@/middleware/auth.js";
import {
  createReview,
  findReview,
  listReviewsByAuthor,
  listReviewHighlights,
  listReviewsForHost,
  replyToReview,
  reviewableStays,
  updateReview,
} from "@/modules/reviews/reviews.repository.js";
import { apiError } from "@/core/errors.js";
import { queryOne } from "@/db/query.js";
import { rateLimit } from "@/middleware/rateLimit.js";
import { createTicket } from "@/modules/admin/support.repository.js";

export const reviewsRouter = Router();

const reviewParams = z.object({ reviewId: z.string().trim().min(1).max(140) });
const bodyText = z.string().trim().min(10, "Write at least 10 characters.").max(2000);

/** Real guest reviews shown on the homepage. Public, no account needed. */
reviewsRouter.get(
  "/highlights",
  asyncHandler(async (_req, res) => ok(res, await listReviewHighlights(5))),
);

/** A single review, readable by anyone. */
reviewsRouter.get(
  "/:reviewId",
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(reviewParams, req);
    const review = await findReview(reviewId, { includeHidden: isAdmin(req) });
    if (!review) {
      throw apiError("NOT_FOUND", { message: `No review exists with the id "${reviewId}".`, details: { reviewId } });
    }
    return ok(res, review);
  }),
);

reviewsRouter.use(requireAuth);

/** Reviews the signed-in guest has written. */
reviewsRouter.get(
  "/mine/written",
  asyncHandler(async (req, res) => ok(res, await listReviewsByAuthor(currentUser(req).userId))),
);

/** Finished stays still waiting for a review. */
reviewsRouter.get(
  "/mine/pending",
  asyncHandler(async (req, res) => ok(res, await reviewableStays(currentUser(req).userId))),
);

/** Reviews across the signed-in host's listings. */
reviewsRouter.get(
  "/host/received",
  asyncHandler(async (req, res) => {
    const needingReply = req.query['needingReply'] === "true";
    return ok(res, await listReviewsForHost(currentUser(req).userId, { needingReply }));
  }),
);

/** Write the review for a completed stay. */
reviewsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z.object({
        bookingId: z.string().trim().min(1).max(140),
        rating: z.number().int().min(1, "Give between 1 and 5 stars.").max(5),
        body: bodyText,
      }),
      req,
    );
    const review = await createReview({ ...body, authorId: currentUser(req).userId });
    req.log.info({ reviewId: review.id, rating: review.rating }, "review created");
    return created(res, review);
  }),
);

reviewsRouter.patch(
  "/:reviewId",
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(reviewParams, req);
    const patch = validateBody(
      z
        .object({ rating: z.number().int().min(1).max(5).optional(), body: bodyText.optional() })
        .refine((value) => value.rating !== undefined || value.body !== undefined, "Send a rating or a new text."),
      req,
    );
    return ok(res, await updateReview(reviewId, currentUser(req).userId, patch));
  }),
);

/** Host's public reply. */
reviewsRouter.post(
  "/:reviewId/reply",
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(reviewParams, req);
    const body = validateBody(z.object({ reply: z.string().trim().min(2).max(2000) }), req);
    const review = await replyToReview({
      reviewId,
      actorId: currentUser(req).userId,
      isAdmin: isAdmin(req),
      reply: body.reply,
    });
    req.log.info({ reviewId }, "review replied");
    return ok(res, review);
  }),
);

/**
 * Guests and hosts can report a review (abusive, false, off-topic…). The
 * report lands in the support desk as a "review" ticket so the moderation
 * team can hide or keep it from the admin reviews screen.
 */
reviewsRouter.post(
  "/:reviewId/report",
  rateLimit({ windowMs: 60 * 60_000, max: 10, name: "review-report" }),
  asyncHandler(async (req, res) => {
    const { reviewId } = validateParams(reviewParams, req);
    const body = validateBody(
      z.object({
        reason: z.enum(["abusive", "false", "off_topic", "personal_data", "other"]),
        details: z.string().trim().max(1000).optional(),
      }),
      req,
    );
    const review = await findReview(reviewId, { includeHidden: false });
    if (!review) throw apiError("NOT_FOUND", { message: "This review no longer exists." });
    const user = currentUser(req);
    const who = await queryOne<{ full_name: string; is_host: boolean }>(
      `SELECT u.full_name, EXISTS (SELECT 1 FROM host_profile h WHERE h.user_id = u.id) AS is_host
         FROM app_user u WHERE u.id = $1`,
      [user.userId],
      { label: "reviews.report.user" },
    );
    const ticket = await createTicket({
      subject: `Review reported: ${reviewId}`,
      category: "review",
      openedBy: user.userId,
      openedByName: who?.full_name || user.email,
      openedByRole: who?.is_host ? "host" : "guest",
      bookingId: review.bookingId ?? null,
      body: `Reason: ${body.reason}\nReview: ${reviewId}${body.details ? `\n\n${body.details}` : ""}`,
    });
    req.log.info({ reviewId }, "review reported");
    return created(res, { ticketReference: (ticket as { reference?: string } | null)?.reference ?? null });
  }),
);
