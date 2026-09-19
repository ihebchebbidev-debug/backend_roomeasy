import type { PoolClient } from "pg";

import { apiError } from "@/core/errors.js";
import { query, queryOne, transaction } from "@/db/query.js";

export type ReviewDto = {
  id: string;
  propertyId: string;
  bookingId: string | null;
  author: string;
  authorId: string | null;
  authorAvatar: string | null;
  rating: number;
  body: string;
  reply: string | null;
  repliedAt: string | null;
  hidden: boolean;
  hiddenReason: string | null;
  date: string;
  createdAt: string;
};

type ReviewRow = {
  id: string;
  property_id: string;
  booking_id: string | null;
  author_id: string | null;
  author_name: string;
  author_avatar: string | null;
  rating: number;
  body: string;
  reply: string | null;
  replied_at: Date | null;
  hidden: boolean;
  hidden_reason: string | null;
  created_on: Date | string;
  created_at: Date;
};

function mapReview(row: ReviewRow): ReviewDto {
  return {
    id: row.id,
    propertyId: row.property_id,
    bookingId: row.booking_id,
    author: row.author_name,
    authorId: row.author_id,
    authorAvatar: row.author_avatar,
    rating: row.rating,
    body: row.body,
    reply: row.reply,
    repliedAt: row.replied_at ? row.replied_at.toISOString() : null,
    hidden: row.hidden,
    hiddenReason: row.hidden_reason,
    date: typeof row.created_on === "string" ? row.created_on.slice(0, 10) : row.created_on.toISOString().slice(0, 10),
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT_REVIEW = `
  SELECT r.id, r.property_id, r.booking_id, r.author_id, r.author_name,
         u.avatar_url AS author_avatar, r.rating, r.body, r.reply, r.replied_at,
         r.hidden, r.hidden_reason, r.created_on, r.created_at
    FROM review r
    LEFT JOIN app_user u ON u.id = r.author_id`;

/** Public review list for a stay page. Hidden rows are admin-only. */
export async function listPropertyReviews(
  propertyId: string,
  options: { limit?: number; offset?: number; includeHidden?: boolean } = {},
): Promise<{ items: ReviewDto[]; total: number }> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const visibility = options.includeHidden ? "" : " AND r.hidden = false";

  const rows = await query<ReviewRow & { total: string }>(
    `${SELECT_REVIEW}
      WHERE r.property_id = $1${visibility}
      ORDER BY r.created_on DESC, r.created_at DESC
      LIMIT $2 OFFSET $3`,
    [propertyId, limit, offset],
    { label: "reviews.listForProperty" },
  );

  const count = await queryOne<{ total: string }>(
    `SELECT count(*)::text AS total FROM review r WHERE r.property_id = $1${visibility}`,
    [propertyId],
    { label: "reviews.countForProperty" },
  );

  return { items: rows.map(mapReview), total: Number(count?.total ?? 0) };
}

export type ReviewHighlightDto = {
  id: string;
  author: string;
  authorAvatar: string | null;
  rating: number;
  body: string;
  propertyId: string;
  propertyName: string;
  city: string;
  country: string;
  date: string;
};

/**
 * Real 5-star guest reviews used on the homepage. Nothing is invented: when no
 * guest has written one yet, this returns an empty list and the section hides.
 */
export async function listReviewHighlights(limit = 5): Promise<ReviewHighlightDto[]> {
  const rows = await query<{
    id: string;
    author_name: string;
    author_avatar: string | null;
    rating: number;
    body: string;
    property_id: string;
    property_name: string;
    city: string;
    country: string;
    created_on: string | Date;
  }>(
    `SELECT r.id, r.author_name, u.avatar_url AS author_avatar, r.rating, r.body,
            r.property_id, p.name AS property_name, p.city, p.country, r.created_on
       FROM review r
       LEFT JOIN app_user u ON u.id = r.author_id
       JOIN property p ON p.id = r.property_id
      WHERE r.hidden = false AND r.rating >= 5 AND length(r.body) >= 60
      ORDER BY r.created_on DESC, r.created_at DESC
      LIMIT $1`,
    [limit],
    { label: "reviews.highlights" },
  );

  return rows.map((row) => ({
    id: row.id,
    author: row.author_name,
    authorAvatar: row.author_avatar,
    rating: row.rating,
    body: row.body,
    propertyId: row.property_id,
    propertyName: row.property_name,
    city: row.city,
    country: row.country,
    date:
      typeof row.created_on === "string" ? row.created_on.slice(0, 10) : row.created_on.toISOString().slice(0, 10),
  }));
}

export async function findReview(reviewId: string, options: { includeHidden?: boolean } = {}): Promise<ReviewDto | null> {
  const row = await queryOne<ReviewRow>(
    `${SELECT_REVIEW} WHERE r.id = $1${options.includeHidden ? "" : " AND r.hidden = false"}`,
    [reviewId],
    { label: "reviews.find" },
  );
  return row ? mapReview(row) : null;
}

/** Reviews written by one guest. */
export async function listReviewsByAuthor(authorId: string): Promise<ReviewDto[]> {
  const rows = await query<ReviewRow>(`${SELECT_REVIEW} WHERE r.author_id = $1 ORDER BY r.created_on DESC`, [authorId], {
    label: "reviews.listByAuthor",
  });
  return rows.map(mapReview);
}

/** Reviews across every listing of one host, for the host dashboard. */
export async function listReviewsForHost(
  hostId: string,
  options: { needingReply?: boolean } = {},
): Promise<ReviewDto[]> {
  const rows = await query<ReviewRow>(
    `${SELECT_REVIEW}
      JOIN property p ON p.id = r.property_id
      WHERE p.host_id = $1 AND r.hidden = false
        ${options.needingReply ? "AND r.reply IS NULL" : ""}
      ORDER BY r.created_on DESC`,
    [hostId],
    { label: "reviews.listForHost" },
  );
  return rows.map(mapReview);
}

/** Recomputes the cached rating/review_count on the property. */
async function refreshPropertyRating(propertyId: string, client?: PoolClient) {
  await query(
    `UPDATE property p SET
       rating = coalesce((SELECT round(avg(rating)::numeric, 2) FROM review r
                           WHERE r.property_id = p.id AND r.hidden = false), 0),
       review_count = (SELECT count(*) FROM review r WHERE r.property_id = p.id AND r.hidden = false),
       updated_at = now()
     WHERE p.id = $1`,
    [propertyId],
    { client, label: "reviews.refreshRating" },
  );
}

/**
 * Creates the review for a completed stay. Only the guest who stayed may write
 * it, and only once — the app keys reviews as `rv-<bookingId>`.
 */
export async function createReview(input: {
  bookingId: string;
  authorId: string;
  rating: number;
  body: string;
}): Promise<ReviewDto> {
  const booking = await queryOne<{
    id: string;
    property_id: string;
    guest_id: string | null;
    guest_name: string;
    status: string;
    check_out: Date | string;
  }>(
    `SELECT id, property_id, guest_id, guest_name, status::text AS status, check_out FROM booking WHERE id = $1`,
    [input.bookingId],
    { label: "reviews.bookingForReview" },
  );

  if (!booking) {
    throw apiError("NOT_FOUND", {
      message: `No booking exists with the reference "${input.bookingId}".`,
      details: { bookingId: input.bookingId },
    });
  }
  if (booking.guest_id !== input.authorId) {
    throw apiError("REVIEW_NOT_ALLOWED", { message: "Only the guest who stayed can review this stay." });
  }

  const checkOut = typeof booking.check_out === "string" ? booking.check_out.slice(0, 10) : booking.check_out.toISOString().slice(0, 10);
  const stayIsOver = checkOut <= new Date().toISOString().slice(0, 10);
  if (booking.status !== "completed" && !(booking.status === "confirmed" && stayIsOver)) {
    throw apiError("REVIEW_NOT_ALLOWED", {
      message: "You can review a stay once it is over.",
      details: { status: booking.status, checkOut },
    });
  }

  const existing = await queryOne<{ id: string }>(`SELECT id FROM review WHERE booking_id = $1`, [input.bookingId], {
    label: "reviews.duplicateCheck",
  });
  if (existing) throw apiError("ALREADY_REVIEWED", { details: { reviewId: existing.id } });

  const authorName = await queryOne<{ full_name: string | null }>(`SELECT full_name FROM app_user WHERE id = $1`, [
    input.authorId,
  ]);

  const review = await transaction(async (client) => {
    const row = await queryOne<ReviewRow>(
      `INSERT INTO review (id, property_id, booking_id, author_id, author_name, rating, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, property_id, booking_id, author_id, author_name, NULL::text AS author_avatar,
                 rating, body, reply, replied_at, hidden, hidden_reason, created_on, created_at`,
      [
        `rv-${input.bookingId}`,
        booking.property_id,
        booking.id,
        input.authorId,
        authorName?.full_name?.trim() || booking.guest_name,
        input.rating,
        input.body.trim(),
      ],
      { client, label: "reviews.insert" },
    );
    await refreshPropertyRating(booking.property_id, client);
    return row!;
  }, "reviews.create");

  return mapReview(review);
}

/** The guest may edit their own wording; the rating and stay stay fixed. */
export async function updateReview(
  reviewId: string,
  authorId: string,
  patch: { rating?: number; body?: string },
): Promise<ReviewDto> {
  const owner = await queryOne<{ author_id: string | null; property_id: string }>(
    `SELECT author_id, property_id FROM review WHERE id = $1`,
    [reviewId],
    { label: "reviews.owner" },
  );
  if (!owner) throw apiError("NOT_FOUND", { message: `No review exists with the id "${reviewId}".` });
  if (owner.author_id !== authorId) {
    throw apiError("FORBIDDEN", { message: "You can only edit a review you wrote." });
  }

  const row = await transaction(async (client) => {
    const updated = await queryOne<ReviewRow>(
      `UPDATE review SET
         rating = coalesce($2, rating),
         body = coalesce($3, body),
         updated_at = now()
       WHERE id = $1
       RETURNING id, property_id, booking_id, author_id, author_name, NULL::text AS author_avatar,
                 rating, body, reply, replied_at, hidden, hidden_reason, created_on, created_at`,
      [reviewId, patch.rating ?? null, patch.body?.trim() ?? null],
      { client, label: "reviews.update" },
    );
    await refreshPropertyRating(owner.property_id, client);
    return updated!;
  }, "reviews.update");

  return mapReview(row);
}

/** Public host reply. Only the host of that listing (or an admin) may reply. */
export async function replyToReview(input: {
  reviewId: string;
  actorId: string;
  isAdmin: boolean;
  reply: string;
}): Promise<ReviewDto> {
  const target = await queryOne<{ host_id: string | null }>(
    `SELECT p.host_id FROM review r JOIN property p ON p.id = r.property_id WHERE r.id = $1`,
    [input.reviewId],
    { label: "reviews.replyTarget" },
  );
  if (!target) throw apiError("NOT_FOUND", { message: `No review exists with the id "${input.reviewId}".` });
  if (!input.isAdmin && target.host_id !== input.actorId) {
    throw apiError("FORBIDDEN", { message: "Only the host of this stay can reply to its reviews." });
  }

  const row = await queryOne<ReviewRow>(
    `UPDATE review SET reply = $2, replied_at = now(), replied_by = $3, updated_at = now()
      WHERE id = $1
      RETURNING id, property_id, booking_id, author_id, author_name, NULL::text AS author_avatar,
                rating, body, reply, replied_at, hidden, hidden_reason, created_on, created_at`,
    [input.reviewId, input.reply.trim(), input.actorId],
    { label: "reviews.reply" },
  );
  return mapReview(row!);
}

/** Admin moderation: hide or restore a review, then refresh the rating. */
export async function setReviewHidden(input: {
  reviewId: string;
  hidden: boolean;
  adminId: string;
  reason?: string | null;
}): Promise<ReviewDto> {
  const existing = await queryOne<{ property_id: string }>(`SELECT property_id FROM review WHERE id = $1`, [
    input.reviewId,
  ]);
  if (!existing) throw apiError("NOT_FOUND", { message: `No review exists with the id "${input.reviewId}".` });

  const row = await transaction(async (client) => {
    const updated = await queryOne<ReviewRow>(
      `UPDATE review SET
         hidden = $2,
         hidden_at = CASE WHEN $2 THEN now() ELSE NULL END,
         hidden_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         hidden_reason = CASE WHEN $2 THEN $4 ELSE NULL END,
         updated_at = now()
       WHERE id = $1
       RETURNING id, property_id, booking_id, author_id, author_name, NULL::text AS author_avatar,
                 rating, body, reply, replied_at, hidden, hidden_reason, created_on, created_at`,
      [input.reviewId, input.hidden, input.adminId, input.reason ?? null],
      { client, label: "reviews.setHidden" },
    );
    await refreshPropertyRating(existing.property_id, client);
    return updated!;
  }, "reviews.moderate");

  return mapReview(row);
}

/** Stays this guest has finished but not yet reviewed — drives the review prompt. */
export async function reviewableStays(guestId: string) {
  const rows = await query<{
    booking_id: string;
    property_id: string;
    property_name: string;
    check_out: Date | string;
    photo: string | null;
  }>(
    `SELECT b.id AS booking_id, b.property_id, p.name AS property_name, b.check_out,
            (SELECT url FROM property_photo ph WHERE ph.property_id = p.id ORDER BY ph.position LIMIT 1) AS photo
       FROM booking b
       JOIN property p ON p.id = b.property_id
      WHERE b.guest_id = $1
        AND (b.status = 'completed' OR (b.status = 'confirmed' AND b.check_out <= CURRENT_DATE))
        AND NOT EXISTS (SELECT 1 FROM review r WHERE r.booking_id = b.id)
      ORDER BY b.check_out DESC`,
    [guestId],
    { label: "reviews.reviewableStays" },
  );

  return rows.map((row) => ({
    bookingId: row.booking_id,
    propertyId: row.property_id,
    propertyName: row.property_name,
    checkOut: typeof row.check_out === "string" ? row.check_out.slice(0, 10) : row.check_out.toISOString().slice(0, 10),
    photo: row.photo,
  }));
}

/** Removes a review for good (admin only) and refreshes the stay's rating. */
export async function deleteReview(reviewId: string): Promise<{ id: string; propertyId: string }> {
  const existing = await queryOne<{ property_id: string }>(`SELECT property_id FROM review WHERE id = $1`, [reviewId]);
  if (!existing) throw apiError("NOT_FOUND", { message: `No review exists with the id "${reviewId}".` });

  await transaction(async (client) => {
    await query(`DELETE FROM review WHERE id = $1`, [reviewId], { client, label: "reviews.delete" });
    await refreshPropertyRating(existing.property_id, client);
  }, "reviews.delete");

  return { id: reviewId, propertyId: existing.property_id };
}

/** Every review on the platform, hidden ones included, for admin moderation. */
export async function listAllReviews(options: { limit?: number; offset?: number } = {}): Promise<ReviewDto[]> {
  const rows = await query<ReviewRow>(
    `${SELECT_REVIEW} ORDER BY r.created_on DESC, r.created_at DESC LIMIT $1 OFFSET $2`,
    [options.limit ?? 200, options.offset ?? 0],
    { label: "reviews.listAll" },
  );
  return rows.map(mapReview);
}
