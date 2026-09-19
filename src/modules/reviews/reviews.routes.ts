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
