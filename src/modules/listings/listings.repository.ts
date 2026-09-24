import { apiError } from "@/core/errors.js";
import { slugify } from "@/core/ids.js";
import { query, queryOne, transaction } from "@/db/query.js";
import { assertEquipmentExists } from "@/modules/equipment/equipment.repository.js";

/**
 * The wizard payload (`src/models/listing.ts :: ListingDraft`) is persisted in
 * two places:
 *   1. normalised across property / listing / photo / amenity / equipment rows;
 *   2. verbatim in `listing_submission`, giving a full edit history.
 */
export type ListingDraft = {
  propertyId: string;
  listingId: string;
  title: string;
  category: string;
  summary: string;
  description: string;
  location: { city: string; country: string; postal: string; neighbourhood: string; lat?: number | null; lng?: number | null };
  capacity: { guests: number; rooms: number; beds: number; baths: number; area: number };
  amenities: string[];
  equipment: string[];
  photos: string[];
  pricing: {
    nightlyUsd: number;
    cleaningFeeUsd: number;
    minNights: number;
    longStay: { enabled: boolean; threshold: number; discount: number };
    mobile: { enabled: boolean; discount: number };
  };
  policies: {
    cancellationPolicy: string;
    houseRules: string;
    checkIn: string;
    checkOut: string;
    instantBook: boolean;
  };
  status: "draft" | "published" | "suspended";
};

export type SavedListing = {
  propertyId: string;
  listingId: string;
  status: string;
  approved: boolean;
  payload: ListingDraft;
  savedAt: string;
};

export type HostListingRow = {
  listingId: string;
  propertyId: string;
  name: string;
  city: string;
  country: string;
  category: string;
  status: string;
  approved: boolean;
  rejectedReason: string | null;
  nightlyUsd: number;
  longStay: { enabled: boolean; threshold: number; discount: number };
  mobile: { enabled: boolean; discount: number };
  guests: number;
  rating: number;
  reviewCount: number;
  photo: string | null;
  upcomingBookings: number;
  publishedAt: string | null;
  updatedAt: string;
};

/** Every field a published listing must carry. Checked before going live. */
function publishBlockers(draft: ListingDraft): string[] {
  const missing: string[] = [];
  if (draft.title.trim().length < 4) missing.push("A title of at least 4 characters");
  if (draft.summary.trim().length < 20) missing.push("A summary of at least 20 characters");
  if (!draft.location.city.trim()) missing.push("The city");
  if (!draft.location.country.trim()) missing.push("The country");
  if (draft.photos.length < 1) missing.push("At least one photo");
  if (!(draft.pricing.nightlyUsd >= 10)) missing.push("A nightly price of at least $10");
  if (!draft.policies.cancellationPolicy) missing.push("A cancellation policy");
  return missing;
}

function timeOrNull(value: string): string | null {
  const trimmed = value.trim();
  return /^\d{1,2}:\d{2}$/.test(trimmed) ? trimmed : null;
}

export function normaliseIds(draft: ListingDraft): ListingDraft {
  const propertyId = draft.propertyId.trim() || slugify(draft.title);
  const listingId = draft.listingId.trim() || `hl-${propertyId}`;
  return { ...draft, propertyId, listingId };
}

/** Throws unless the caller owns the listing (admins pass through). */
export async function assertListingOwner(
  listingId: string,
  actor: { userId: string; isAdmin: boolean },
): Promise<{ listingId: string; propertyId: string; hostId: string | null; status: string; approved: boolean }> {
  const row = await queryOne<{
    id: string;
    property_id: string;
    host_id: string | null;
    status: string;
    approved: boolean;
  }>(
    `SELECT l.id, l.property_id, p.host_id, l.status::text AS status, l.approved
       FROM listing l JOIN property p ON p.id = l.property_id
      WHERE l.id = $1`,
    [listingId],
    { label: "listings.owner" },
  );

  if (!row) {
    throw apiError("NOT_FOUND", { message: `No listing exists with the id "${listingId}".`, details: { listingId } });
  }
  if (!actor.isAdmin && row.host_id !== actor.userId) {
    throw apiError("FORBIDDEN", { message: "This listing belongs to another host.", details: { listingId } });
  }

  return {
    listingId: row.id,
    propertyId: row.property_id,
    hostId: row.host_id,
    status: row.status,
    approved: row.approved,
  };
}

/**
 * Creates or updates a listing from one wizard payload.
 *
 * Publishing requires a complete payload; approval stays with the admin, so a
 * newly published listing is stored as `published` + `approved = false` and
 * only becomes visible to guests once an admin approves it.
 */
export async function saveListing(input: {
  draft: ListingDraft;
  hostId: string;
  actorId: string;
  isAdmin: boolean;
}): Promise<SavedListing> {
  const draft = normaliseIds(input.draft);

  if (draft.photos.length > 10) {
    throw apiError("PHOTO_LIMIT_REACHED", { details: { sent: draft.photos.length, max: 10 } });
  }
  await assertEquipmentExists(draft.equipment);

  if (draft.status === "published") {
    const missing = publishBlockers(draft);
    if (missing.length) {
      throw apiError("LISTING_INCOMPLETE", {
        message: `This listing cannot be published yet. Still missing: ${missing.join("; ")}.`,
        details: { missing },
      });
    }
  }

  // A slug already used by another host must not be silently overwritten.
  const existing = await queryOne<{ id: string; host_id: string | null }>(
    `SELECT id, host_id FROM property WHERE id = $1`,
    [draft.propertyId],
    { label: "listings.slugCheck" },
  );
  if (existing && existing.host_id && existing.host_id !== input.hostId && !input.isAdmin) {
    throw apiError("PROPERTY_ID_TAKEN", { details: { propertyId: draft.propertyId } });
  }

  const savedAt = await transaction(async (client) => {
    await query(
      `INSERT INTO property (
         id, host_id, name, category, summary, description, city, country, neighbourhood, postal_code,
         guests, rooms, beds, baths, area_sqm, base_price_usd, cleaning_fee_usd, min_nights,
         cancellation_policy, house_rules, check_in, check_out, instant_book, latitude, longitude)
       VALUES ($1, $2, $3, $4::property_category, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18,
               $19::cancellation_policy, $20, $21::time, $22::time, $23, $24, $25)
       ON CONFLICT (id) DO UPDATE SET
         host_id = coalesce(property.host_id, excluded.host_id),
         name = excluded.name, category = excluded.category, summary = excluded.summary,
         description = excluded.description, city = excluded.city, country = excluded.country,
         neighbourhood = excluded.neighbourhood, postal_code = excluded.postal_code,
         guests = excluded.guests, rooms = excluded.rooms, beds = excluded.beds, baths = excluded.baths,
         area_sqm = excluded.area_sqm, base_price_usd = excluded.base_price_usd,
         cleaning_fee_usd = excluded.cleaning_fee_usd, min_nights = excluded.min_nights,
         cancellation_policy = excluded.cancellation_policy, house_rules = excluded.house_rules,
         check_in = excluded.check_in, check_out = excluded.check_out, instant_book = excluded.instant_book,
         latitude = coalesce(excluded.latitude, property.latitude), longitude = coalesce(excluded.longitude, property.longitude),
         updated_at = now()`,
      [
        draft.propertyId,
        input.hostId,
        draft.title.trim(),
        draft.category,
        draft.summary.trim() || null,
        draft.description.trim() || null,
        draft.location.city.trim(),
        draft.location.country.trim(),
        draft.location.neighbourhood.trim() || null,
        draft.location.postal.trim() || null,
        draft.capacity.guests,
        draft.capacity.rooms,
        draft.capacity.beds,
        draft.capacity.baths,
        draft.capacity.area,
        draft.pricing.nightlyUsd,
        draft.pricing.cleaningFeeUsd,
        draft.pricing.minNights,
        draft.policies.cancellationPolicy,
        draft.policies.houseRules.trim() || null,
        timeOrNull(draft.policies.checkIn),
        timeOrNull(draft.policies.checkOut),
        draft.policies.instantBook,
        draft.location.lat ?? null,
        draft.location.lng ?? null,
      ],
      { client, label: "listings.upsertProperty" },
    );

    // Photos, amenities and equipment are replaced wholesale: the wizard always
    // sends the complete set.
    await query(`DELETE FROM property_photo WHERE property_id = $1`, [draft.propertyId], { client });
    if (draft.photos.length) {
      await query(
        `INSERT INTO property_photo (property_id, url, position)
         SELECT $1, url, (ordinality - 1)::int FROM unnest($2::text[]) WITH ORDINALITY AS t(url, ordinality)`,
        [draft.propertyId, draft.photos],
        { client, label: "listings.replacePhotos" },
      );
    }

    await query(`DELETE FROM property_amenity WHERE property_id = $1`, [draft.propertyId], { client });
    if (draft.amenities.length) {
      await query(
        `INSERT INTO property_amenity (property_id, amenity)
         SELECT $1, amenity::amenity_id FROM unnest($2::text[]) AS t(amenity)
         ON CONFLICT DO NOTHING`,
        [draft.propertyId, draft.amenities],
        { client, label: "listings.replaceAmenities" },
      );
    }

    await query(`DELETE FROM property_equipment WHERE property_id = $1`, [draft.propertyId], { client });
    if (draft.equipment.length) {
      await query(
        `INSERT INTO property_equipment (property_id, equipment_id)
         SELECT $1, equipment_id FROM unnest($2::text[]) AS t(equipment_id)
         ON CONFLICT DO NOTHING`,
        [draft.propertyId, draft.equipment],
        { client, label: "listings.replaceEquipment" },
      );
    }

    await query(
      `INSERT INTO property_translation (property_id, locale, location_label, name, summary, description)
       VALUES ($1, 'en', $2, $3, $4, $5)
       ON CONFLICT (property_id, locale) DO UPDATE
         SET location_label = excluded.location_label, name = excluded.name,
             summary = excluded.summary, description = excluded.description`,
      [
        draft.propertyId,
        `${draft.location.city.trim()}, ${draft.location.country.trim()}`,
        draft.title.trim(),
        draft.summary.trim() || null,
        draft.description.trim() || null,
      ],
      { client, label: "listings.upsertTranslation" },
    );

    const listing = await queryOne<{ updated_at: Date }>(
      `INSERT INTO listing (
         id, property_id, status, nightly_usd, long_stay_enabled, long_stay_threshold, long_stay_discount,
         mobile_enabled, mobile_discount, published_at)
       VALUES ($1, $2, $3::listing_status, $4, $5, $6, $7, $8, $9,
               CASE WHEN $3 = 'published' THEN now() ELSE NULL END)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         nightly_usd = excluded.nightly_usd,
         long_stay_enabled = excluded.long_stay_enabled,
         long_stay_threshold = excluded.long_stay_threshold,
         long_stay_discount = excluded.long_stay_discount,
         mobile_enabled = excluded.mobile_enabled,
         mobile_discount = excluded.mobile_discount,
         published_at = CASE WHEN excluded.status = 'published'
                             THEN coalesce(listing.published_at, now()) ELSE listing.published_at END,
         rejected_reason = CASE WHEN excluded.status = 'published' THEN NULL ELSE listing.rejected_reason END,
         -- A host editing a live listing sends it back through moderation: the
         -- edited version only goes public once an admin approves it again.
         approved = CASE WHEN excluded.status = 'published' THEN false ELSE listing.approved END,
         updated_at = now()
       RETURNING updated_at`,
      [
        draft.listingId,
        draft.propertyId,
        draft.status,
        draft.pricing.nightlyUsd,
        draft.pricing.longStay.enabled,
        draft.pricing.longStay.threshold,
        draft.pricing.longStay.discount,
        draft.pricing.mobile.enabled,
        draft.pricing.mobile.discount,
      ],
      { client, label: "listings.upsertListing" },
    );

    await query(
      `INSERT INTO listing_submission (listing_id, property_id, submitted_by, status, payload)
       VALUES ($1, $2, $3, $4::listing_status, $5::jsonb)`,
      [draft.listingId, draft.propertyId, input.actorId, draft.status, JSON.stringify(draft)],
      { client, label: "listings.recordSubmission" },
    );

    return listing!.updated_at.toISOString();
  }, "listings.save");

  const approval = await queryOne<{ approved: boolean }>(`SELECT approved FROM listing WHERE id = $1`, [
    draft.listingId,
  ]);

  return {
    propertyId: draft.propertyId,
    listingId: draft.listingId,
    status: draft.status,
    approved: approval?.approved ?? false,
    payload: draft,
    savedAt,
  };
}

export async function setListingStatus(
  listingId: string,
  status: "draft" | "published" | "suspended",
): Promise<{ listingId: string; status: string; approved: boolean }> {
  const row = await queryOne<{ id: string; status: string; approved: boolean }>(
    `UPDATE listing SET
       status = $2::listing_status,
       published_at = CASE WHEN $2 = 'published' THEN coalesce(published_at, now()) ELSE published_at END,
       updated_at = now()
     WHERE id = $1
     RETURNING id, status::text AS status, approved`,
    [listingId, status],
    { label: "listings.setStatus" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: `No listing exists with the id "${listingId}".` });
  return { listingId: row.id, status: row.status, approved: row.approved };
}

/**
 * Deletes the listing and its property. Refused while live bookings exist, so
 * a guest can never lose a stay they already paid for.
 */
export async function deleteListing(listingId: string): Promise<void> {
  const row = await queryOne<{ property_id: string; live: string; total: string }>(
    `SELECT l.property_id,
            (SELECT count(*)::text FROM booking b
              WHERE b.property_id = l.property_id AND b.status IN ('pending', 'confirmed')) AS live,
            (SELECT count(*)::text FROM booking b
              WHERE b.property_id = l.property_id) AS total
       FROM listing l WHERE l.id = $1`,
    [listingId],
    { label: "listings.deleteCheck" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: `No listing exists with the id "${listingId}".` });

  if (Number(row.live) > 0) {
    throw apiError("LISTING_HAS_BOOKINGS", {
      message: `This listing has ${row.live} live booking(s). Cancel or complete them before deleting it.`,
      details: { liveBookings: Number(row.live), totalBookings: Number(row.total) },
    });
  }

  // Past bookings must be kept for accounting, and the booking → property foreign
  // key is RESTRICT, so a listing with any booking history can only be unpublished.
  if (Number(row.total) > 0) {
    throw apiError("LISTING_HAS_BOOKINGS", {
      message: `This listing has ${row.total} past booking(s) kept for accounting and cannot be deleted. Unpublish it instead.`,
      details: { liveBookings: 0, totalBookings: Number(row.total) },
    });
  }

  // property → listing is ON DELETE CASCADE, so one delete clears both.
  await query(`DELETE FROM property WHERE id = $1`, [row.property_id], { label: "listings.delete" });
}

export async function listHostListings(hostId: string): Promise<HostListingRow[]> {
  const rows = await query<{
    listing_id: string;
    property_id: string;
    name: string;
    city: string;
    country: string;
    category: string;
    status: string;
    approved: boolean;
    rejected_reason: string | null;
    nightly_usd: string;
    long_stay_enabled: boolean;
    long_stay_threshold: number;
    long_stay_discount: string;
    mobile_enabled: boolean;
    mobile_discount: string;
    guests: number;
    rating: string;
    review_count: number;
    photo: string | null;
    upcoming_bookings: string;
    published_at: Date | null;
    updated_at: Date;
  }>(
    `SELECT l.id AS listing_id, l.property_id, p.name, p.city, p.country, p.category::text AS category,
            l.status::text AS status, l.approved, l.rejected_reason, l.nightly_usd,
            l.long_stay_enabled, l.long_stay_threshold, l.long_stay_discount,
            l.mobile_enabled, l.mobile_discount, p.guests,
            p.rating, p.review_count,
            (SELECT url FROM property_photo ph WHERE ph.property_id = p.id ORDER BY ph.position LIMIT 1) AS photo,
            (SELECT count(*)::text FROM booking b
              WHERE b.property_id = p.id AND b.status IN ('pending', 'confirmed')) AS upcoming_bookings,
            l.published_at, l.updated_at
       FROM listing l
       JOIN property p ON p.id = l.property_id
      WHERE p.host_id = $1
      ORDER BY l.updated_at DESC`,
    [hostId],
    { label: "listings.listForHost" },
  );

  return rows.map((row) => ({
    listingId: row.listing_id,
    propertyId: row.property_id,
    name: row.name,
    city: row.city,
    country: row.country,
    category: row.category,
    status: row.status,
    approved: row.approved,
    rejectedReason: row.rejected_reason,
    nightlyUsd: Number(row.nightly_usd),
    longStay: {
      enabled: row.long_stay_enabled,
      threshold: row.long_stay_threshold,
      discount: Number(row.long_stay_discount),
    },
    mobile: { enabled: row.mobile_enabled, discount: Number(row.mobile_discount) },
    guests: row.guests,
    rating: Number(row.rating),
    reviewCount: row.review_count,
    photo: row.photo,
    upcomingBookings: Number(row.upcoming_bookings),
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/** Wizard edit history, newest first. */
export async function listSubmissions(listingId: string, limit = 20) {
  const rows = await query<{ id: string; status: string; payload: ListingDraft; submitted_at: Date; author: string | null }>(
    `SELECT s.id, s.status::text AS status, s.payload, s.submitted_at, u.full_name AS author
       FROM listing_submission s
       LEFT JOIN app_user u ON u.id = s.submitted_by
      WHERE s.listing_id = $1
      ORDER BY s.submitted_at DESC
      LIMIT $2`,
    [listingId, limit],
    { label: "listings.submissions" },
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    payload: row.payload,
    author: row.author,
    submittedAt: row.submitted_at.toISOString(),
  }));
}

/** The latest saved payload, so the wizard can resume an edit. */
export async function latestSubmission(listingId: string): Promise<ListingDraft | null> {
  const row = await queryOne<{ payload: ListingDraft }>(
    `SELECT payload FROM listing_submission WHERE listing_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [listingId],
    { label: "listings.latestSubmission" },
  );
  return row?.payload ?? null;
}
