import { apiError } from "@/core/errors.js";
import { payoutId as newPayoutId } from "@/core/ids.js";
import { query, queryOne, transaction } from "@/db/query.js";
import type { Role } from "@/middleware/auth.js";
import { transferPayoutToHost } from "@/modules/payments/payouts.js";

/**
 * Everything the admin console shows (`src/routes/admin.tsx`): the overview
 * cards, listing approvals, the user directory, review moderation, payouts and
 * the reports tab.
 */

export type AdminOverview = {
  users: { total: number; guests: number; hosts: number; admins: number; suspended: number };
  listings: { total: number; published: number; awaitingApproval: number; suspended: number };
  bookings: { total: number; pending: number; confirmed: number; completed: number; cancelled: number };
  revenue: { grossUsd: number; commissionUsd: number; payoutsUsd: number; payoutsPendingUsd: number };
  reviews: { total: number; hidden: number; averageRating: number };
};

export async function adminOverview(): Promise<AdminOverview> {
  const users = await queryOne<{
    total: string;
    guests: string;
    hosts: string;
    admins: string;
    suspended: string;
  }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM user_role_grant g
                                                WHERE g.user_id = u.id AND g.role IN ('host','admin'))) AS guests,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_role_grant g
                                            WHERE g.user_id = u.id AND g.role = 'host')) AS hosts,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_role_grant g
                                            WHERE g.user_id = u.id AND g.role = 'admin')) AS admins,
            count(*) FILTER (WHERE u.suspended) AS suspended
       FROM app_user u`,
    [],
    { label: "admin.overview.users" },
  );

  const listings = await queryOne<{ total: string; published: string; awaiting: string; suspended: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status = 'published' AND approved) AS published,
            count(*) FILTER (WHERE NOT approved) AS awaiting,
            count(*) FILTER (WHERE status = 'suspended') AS suspended
       FROM listing`,
    [],
    { label: "admin.overview.listings" },
  );

  const bookings = await queryOne<{
    total: string;
    pending: string;
    confirmed: string;
    completed: string;
    cancelled: string;
    gross: string;
    commission: string;
  }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
            count(*) FILTER (WHERE status = 'completed') AS completed,
            count(*) FILTER (WHERE status IN ('cancelled','declined')) AS cancelled,
            coalesce(sum(total_usd / nullif(fx_rate_to_eur, 0)) FILTER (WHERE status IN ('confirmed','completed')), 0) AS gross,
            coalesce(sum(service_fee / nullif(fx_rate_to_eur, 0)) FILTER (WHERE status IN ('confirmed','completed')), 0) AS commission
       FROM booking`,
    [],
    { label: "admin.overview.bookings" },
  );

  const payouts = await queryOne<{ paid: string; pending: string }>(
    `SELECT coalesce(sum(amount_usd / coalesce((SELECT rate FROM exchange_rate xr WHERE xr.base_currency = 'EUR' AND xr.quote_currency = payout.currency), 1)) FILTER (WHERE status = 'paid'), 0) AS paid,
            coalesce(sum(amount_usd / coalesce((SELECT rate FROM exchange_rate xr WHERE xr.base_currency = 'EUR' AND xr.quote_currency = payout.currency), 1)) FILTER (WHERE status = 'scheduled'), 0) AS pending
       FROM payout`,
    [],
    { label: "admin.overview.payouts" },
  );

  const reviews = await queryOne<{ total: string; hidden: string; average: string | null }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE hidden) AS hidden,
            avg(rating) FILTER (WHERE NOT hidden) AS average
       FROM review`,
    [],
    { label: "admin.overview.reviews" },
  );

  return {
    users: {
      total: Number(users?.total ?? 0),
      guests: Number(users?.guests ?? 0),
      hosts: Number(users?.hosts ?? 0),
      admins: Number(users?.admins ?? 0),
      suspended: Number(users?.suspended ?? 0),
    },
    listings: {
      total: Number(listings?.total ?? 0),
      published: Number(listings?.published ?? 0),
      awaitingApproval: Number(listings?.awaiting ?? 0),
      suspended: Number(listings?.suspended ?? 0),
    },
    bookings: {
      total: Number(bookings?.total ?? 0),
      pending: Number(bookings?.pending ?? 0),
      confirmed: Number(bookings?.confirmed ?? 0),
      completed: Number(bookings?.completed ?? 0),
      cancelled: Number(bookings?.cancelled ?? 0),
    },
    revenue: {
      grossUsd: Number(bookings?.gross ?? 0),
      commissionUsd: Number(bookings?.commission ?? 0),
      payoutsUsd: Number(payouts?.paid ?? 0),
      payoutsPendingUsd: Number(payouts?.pending ?? 0),
    },
    reviews: {
      total: Number(reviews?.total ?? 0),
      hidden: Number(reviews?.hidden ?? 0),
      averageRating: reviews?.average ? Number(Number(reviews.average).toFixed(2)) : 0,
    },
  };
}

// --- listing approvals -------------------------------------------------------

export type AdminListingRow = {
  listingId: string;
  propertyId: string;
  name: string;
  city: string;
  country: string;
  category: string;
  hostId: string | null;
  hostName: string | null;
  status: "draft" | "published" | "suspended";
  approved: boolean;
  rejectedReason: string | null;
  nightlyUsd: number;
  photoCount: number;
  createdAt: string;
};

type ListingRow = {
  listing_id: string;
  property_id: string;
  name: string;
  city: string;
  country: string;
  category: string;
  host_id: string | null;
  host_name: string | null;
  status: "draft" | "published" | "suspended";
  approved: boolean;
  rejected_reason: string | null;
  nightly_usd: string;
  photo_count: string;
  created_at: Date;
};

function mapListing(row: ListingRow): AdminListingRow {
  return {
    listingId: row.listing_id,
    propertyId: row.property_id,
    name: row.name,
    city: row.city,
    country: row.country,
    category: row.category,
    hostId: row.host_id,
    hostName: row.host_name,
    status: row.status,
    approved: row.approved,
    rejectedReason: row.rejected_reason,
    nightlyUsd: Number(row.nightly_usd),
    photoCount: Number(row.photo_count),
    createdAt: row.created_at.toISOString(),
  };
}

export async function listListingsForReview(options: {
  scope: "pending" | "published" | "suspended" | "all";
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ items: AdminListingRow[]; total: number }> {
  const values: unknown[] = [];
  const where: string[] = [];

  if (options.scope === "pending") where.push("l.approved = false");
  if (options.scope === "published") where.push("l.status = 'published' AND l.approved");
  if (options.scope === "suspended") where.push("l.status = 'suspended'");

  if (options.search?.trim()) {
    values.push(`%${options.search.trim()}%`);
    where.push(`(p.name ILIKE $${values.length} OR p.city ILIKE $${values.length} OR l.id ILIKE $${values.length})`);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  values.push(options.limit, options.offset);

  const rows = await query<ListingRow>(
    `SELECT l.id AS listing_id, l.property_id, p.name, p.city, p.country, p.category::text AS category,
            p.host_id, coalesce(hp.display_name, hu.full_name) AS host_name,
            l.status::text AS status, l.approved, l.rejected_reason, l.nightly_usd,
            (SELECT count(*) FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count,
            l.created_at
       FROM listing l
       JOIN property p ON p.id = l.property_id
       LEFT JOIN host_profile hp ON hp.user_id = p.host_id
       LEFT JOIN app_user hu ON hu.id = p.host_id
       ${clause}
      ORDER BY l.approved, l.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "admin.listListings" },
  );

  const total = await queryOne<{ total: string }>(
    `SELECT count(*) AS total FROM listing l JOIN property p ON p.id = l.property_id ${clause}`,
    values.slice(0, values.length - 2),
    { label: "admin.countListings" },
  );

  return { items: rows.map(mapListing), total: Number(total?.total ?? 0) };
}

async function loadListing(listingId: string): Promise<ListingRow> {
  const row = await queryOne<ListingRow>(
    `SELECT l.id AS listing_id, l.property_id, p.name, p.city, p.country, p.category::text AS category,
            p.host_id, coalesce(hp.display_name, hu.full_name) AS host_name,
            l.status::text AS status, l.approved, l.rejected_reason, l.nightly_usd,
            (SELECT count(*) FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count,
            l.created_at
       FROM listing l
       JOIN property p ON p.id = l.property_id
       LEFT JOIN host_profile hp ON hp.user_id = p.host_id
       LEFT JOIN app_user hu ON hu.id = p.host_id
      WHERE l.id = $1`,
    [listingId],
    { label: "admin.loadListing" },
  );
  if (!row) {
    throw apiError("NOT_FOUND", { message: "That listing does not exist.", details: { listingId } });
  }
  return row;
}

/** Approves a listing and publishes it. */
export async function approveListing(listingId: string): Promise<AdminListingRow> {
  const current = await loadListing(listingId);
  if (current.approved && current.status === "published") {
    throw apiError("CONFLICT", {
      message: "This listing is already approved and live.",
      details: { listingId, status: current.status },
    });
  }
  if (Number(current.photo_count) < 1) {
    throw apiError("LISTING_INCOMPLETE", {
      message: "This listing has no photo yet, so it cannot be approved.",
      details: { listingId },
    });
  }

  await query(
    `UPDATE listing
        SET approved = true, status = 'published', rejected_reason = NULL,
            published_at = coalesce(published_at, now()), updated_at = now()
      WHERE id = $1`,
    [listingId],
    { label: "admin.approveListing" },
  );
  return mapListing(await loadListing(listingId));
}

/** Refuses a listing and sends it back to the host as a draft with a reason. */
export async function rejectListing(listingId: string, reason: string): Promise<AdminListingRow> {
  await loadListing(listingId);
  await query(
    `UPDATE listing SET approved = false, status = 'draft', rejected_reason = $2, updated_at = now() WHERE id = $1`,
    [listingId, reason],
    { label: "admin.rejectListing" },
  );
  return mapListing(await loadListing(listingId));
}

/** Takes a live listing offline, or puts a suspended one back. */
export async function setListingSuspended(listingId: string, suspended: boolean): Promise<AdminListingRow> {
  const current = await loadListing(listingId);
  if (suspended && current.status === "suspended") {
    throw apiError("CONFLICT", { message: "This listing is already suspended.", details: { listingId } });
  }
  if (!suspended && current.status !== "suspended") {
    throw apiError("CONFLICT", { message: "This listing is not suspended.", details: { listingId } });
  }

  const nextStatus = suspended ? "suspended" : current.approved ? "published" : "draft";
  await query(`UPDATE listing SET status = $2::listing_status, updated_at = now() WHERE id = $1`, [
    listingId,
    nextStatus,
  ], { label: "admin.setListingSuspended" });
  return mapListing(await loadListing(listingId));
}

// --- user directory ----------------------------------------------------------

export type AdminUserRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  roles: Role[];
  verified: boolean;
  suspended: boolean;
  suspendedReason: string | null;
  /** End of a temporary suspension; null when the suspension has no end date. */
  suspendedUntil: string | null;
  banned: boolean;
  joinedOn: string;
  lastLoginAt: string | null;
  bookings: number;
  listings: number;
  verificationStatus: "none" | "pending" | "verified" | "rejected";
};

export async function listUsers(options: {
  search?: string;
  role?: Role;
  suspended?: boolean;
  /** Narrows the list to one account, used when returning a just-changed row. */
  userId?: string;
  limit: number;
  offset: number;
}): Promise<{ items: AdminUserRow[]; total: number }> {
  await liftExpiredSuspensions();

  const values: unknown[] = [];
  const where: string[] = [];

  if (options.userId) {
    values.push(options.userId);
    where.push(`u.id = $${values.length}`);
  }
  if (options.search?.trim()) {
    // Phone numbers are searched digit-only, so "+216 55 123" also finds "21655123".
    const term = options.search.trim();
    values.push(`%${term}%`);
    const like = `$${values.length}`;
    values.push(`%${term.replace(/\D+/g, "")}%`);
    const digits = `$${values.length}`;
    where.push(
      `(u.full_name ILIKE ${like} OR u.email ILIKE ${like}` +
        ` OR (u.phone IS NOT NULL AND (u.phone ILIKE ${like}` +
        ` OR (${digits} <> '%%' AND regexp_replace(u.phone, '\\D', '', 'g') ILIKE ${digits}))))`,
    );
  }
  if (options.role) {
    values.push(options.role);
    where.push(
      `EXISTS (SELECT 1 FROM user_role_grant g WHERE g.user_id = u.id AND g.role = $${values.length}::user_role)`,
    );
  }
  if (options.suspended !== undefined) {
    values.push(options.suspended);
    where.push(`u.suspended = $${values.length}`);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countValues = [...values];
  values.push(options.limit, options.offset);

  const rows = await query<{
    id: string;
    full_name: string;
    email: string;
    phone: string | null;
    roles: string[] | null;
    verified: boolean;
    suspended: boolean;
    suspended_reason: string | null;
    suspended_until: Date | null;
    banned: boolean;
    joined_on: Date;
    last_login_at: Date | null;
    bookings: string;
    listings: string;
    verification_status: string | null;
  }>(
    `SELECT u.id, u.full_name, u.email, u.phone, u.verified, u.suspended, u.suspended_reason,
            u.suspended_until, u.banned,
            u.joined_on, u.last_login_at,
            (SELECT array_agg(g.role::text) FROM user_role_grant g WHERE g.user_id = u.id) AS roles,
            (SELECT count(*) FROM booking b WHERE b.guest_id = u.id) AS bookings,
            (SELECT count(*) FROM property p WHERE p.host_id = u.id) AS listings,
            (SELECT v.status::text FROM identity_verification v WHERE v.user_id = u.id LIMIT 1) AS verification_status
       FROM app_user u
       ${clause}
      ORDER BY u.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "admin.listUsers" },
  );

  const total = await queryOne<{ total: string }>(`SELECT count(*) AS total FROM app_user u ${clause}`, countValues, {
    label: "admin.countUsers",
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      roles: ((row.roles ?? ["guest"]) as Role[]).length ? ((row.roles ?? []) as Role[]) : (["guest"] as Role[]),
      verified: row.verified,
      suspended: row.suspended,
      suspendedReason: row.suspended_reason,
      suspendedUntil: row.suspended_until ? row.suspended_until.toISOString() : null,
      banned: row.banned,
      joinedOn: row.joined_on.toISOString().slice(0, 10),
      lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
      bookings: Number(row.bookings),
      listings: Number(row.listings),
      verificationStatus: (row.verification_status ?? "none") as AdminUserRow["verificationStatus"],
    })),
    total: Number(total?.total ?? 0),
  };
}

/**
 * Clears temporary suspensions whose end date has passed. Banned accounts stay
 * suspended: their ban has no end date.
 */
export async function liftExpiredSuspensions(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE app_user
        SET suspended = false, suspended_reason = NULL, suspended_until = NULL, updated_at = now()
      WHERE suspended AND NOT banned AND suspended_until IS NOT NULL AND suspended_until <= now()
      RETURNING id`,
    [],
    { label: "admin.liftExpiredSuspensions" },
  );
  return rows.length;
}

/** Suspends or restores an account. An admin cannot suspend their own login. */
export async function setUserSuspended(input: {
  userId: string;
  suspended: boolean;
  reason?: string | null;
  /** ISO date/time the suspension lifts itself; null or omitted means no end date. */
  until?: string | null;
  actingAdminId: string;
}): Promise<AdminUserRow> {
  if (input.userId === input.actingAdminId && input.suspended) {
    throw apiError("CONFLICT", { message: "You cannot suspend your own administrator account." });
  }

  const until = input.suspended && input.until ? new Date(input.until) : null;
  if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) {
    throw apiError("VALIDATION_FAILED", { message: "The end of the suspension must be a future date." });
  }

  const rows = await query<{ id: string }>(
    `UPDATE app_user
        SET suspended = $2, suspended_reason = $3, suspended_until = $4, updated_at = now()
      WHERE id = $1 RETURNING id`,
    [input.userId, input.suspended, input.suspended ? (input.reason ?? null) : null, until],
    { label: "admin.setUserSuspended" },
  );
  if (!rows.length) {
    throw apiError("NOT_FOUND", { message: "That account does not exist.", details: { userId: input.userId } });
  }

  // Return the account that was just changed — never an arbitrary first page row.
  const { items } = await listUsers({ userId: input.userId, limit: 1, offset: 0 });
  const found = items.find((user) => user.id === input.userId);
  if (!found) {
    throw apiError("NOT_FOUND", { message: "That account does not exist.", details: { userId: input.userId } });
  }
  return found;
}

// --- host profile ------------------------------------------------------------

export type AdminHostProfile = {
  host: AdminUserRow & {
    displayName: string | null;
    hostingSince: number | null;
    superhost: boolean;
    bannedReason: string | null;
    commissionRate: number | null;
    defaultCommissionRate: number;
    verificationStatus: "none" | "pending" | "verified" | "rejected";
    stripeIdentityStatus: string;
    stripeRequirements: string[];
    stripeCheckedAt: string | null;
  };
  totals: {
    listings: number;
    publishedListings: number;
    bookings: number;
    completedBookings: number;
    cancelledBookings: number;
    grossRevenueUsd: number;
    commissionUsd: number;
    averageRating: number;
    reviews: number;
  };
  listings: AdminListingRow[];
  bookings: Array<{
    id: string;
    reference: string;
    propertyId: string;
    propertyName: string;
    guestName: string;
    checkIn: string;
    checkOut: string;
    status: string;
    totalUsd: number;
  }>;
  reviews: Array<{
    id: string;
    propertyId: string;
    propertyName: string;
    authorName: string;
    rating: number;
    body: string;
    hidden: boolean;
    createdAt: string | null;
  }>;
  documents: Array<{
    id: string;
    status: string;
    documentKind: string | null;
    documentReference: string | null;
    documentFiles: string[] | null;
    notes: string | null;
    createdAt: string;
    decidedAt: string | null;
  }>;
  trips: Array<{
    id: string;
    reference: string;
    propertyId: string;
    propertyName: string;
    checkIn: string;
    checkOut: string;
    status: string;
    totalUsd: number;
  }>;
};

/** Everything an admin needs about one host on a single screen. */
export async function hostProfile(hostId: string): Promise<AdminHostProfile> {
  const { items } = await listUsers({ userId: hostId, limit: 1, offset: 0 });
  const account = items.find((user) => user.id === hostId);
  if (!account) {
    throw apiError("NOT_FOUND", { message: "That host does not exist.", details: { hostId } });
  }

  const extra = await queryOne<{
    display_name: string | null;
    hosting_since: number | null;
    superhost: boolean | null;
    banned_reason: string | null;
    commission_rate: string | null;
    default_rate: string | null;
    verification_status: string | null;
    stripe_identity_status: string | null;
    stripe_requirements: string[] | null;
    stripe_checked_at: Date | null;
  }>(
    `SELECT h.display_name, h.hosting_since, h.superhost, u.banned_reason,
            c.commission_rate::text AS commission_rate,
            (SELECT commission_rate FROM platform_settings WHERE id = true)::text AS default_rate,
            (SELECT v.status::text FROM identity_verification v
              WHERE v.user_id = u.id ORDER BY v.created_at DESC LIMIT 1) AS verification_status,
            (SELECT v.stripe_status FROM identity_verification v WHERE v.user_id = u.id LIMIT 1) AS stripe_identity_status,
            (SELECT v.stripe_requirements FROM identity_verification v WHERE v.user_id = u.id LIMIT 1) AS stripe_requirements,
            (SELECT v.stripe_checked_at FROM identity_verification v WHERE v.user_id = u.id LIMIT 1) AS stripe_checked_at
       FROM app_user u
       LEFT JOIN host_profile h ON h.user_id = u.id
       LEFT JOIN host_commission c ON c.host_id = u.id
      WHERE u.id = $1`,
    [hostId],
    { label: "admin.hostProfile.account" },
  );

  const listingRows = await query<ListingRow>(
    `SELECT l.id AS listing_id, l.property_id, p.name, p.city, p.country, p.category::text AS category,
            p.host_id, hu.full_name AS host_name, l.status::text AS status, l.approved, l.rejected_reason,
            l.nightly_usd, (SELECT count(*) FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count,
            l.created_at
       FROM listing l
       JOIN property p ON p.id = l.property_id
       LEFT JOIN app_user hu ON hu.id = p.host_id
      WHERE p.host_id = $1
      ORDER BY l.created_at DESC
      LIMIT 200`,
    [hostId],
    { label: "admin.hostProfile.listings" },
  );

  const bookingRows = await query<{
    id: string;
    reference: string;
    property_id: string;
    property_name: string;
    guest_name: string;
    check_in: Date;
    check_out: Date;
    status: string;
    total_usd: string;
    service_fee: string;
    currency: string;
    fx_rate_to_eur: string;
  }>(
    `SELECT b.id, b.reference, b.property_id, p.name AS property_name, b.guest_name,
            b.check_in, b.check_out, b.status::text AS status, b.total_usd, b.service_fee,
            b.currency, b.fx_rate_to_eur
       FROM booking b
       JOIN property p ON p.id = b.property_id
      WHERE p.host_id = $1
      ORDER BY b.check_in DESC
      LIMIT 200`,
    [hostId],
    { label: "admin.hostProfile.bookings" },
  );

  const reviewRows = await query<{
    id: string;
    property_id: string;
    property_name: string;
    author_name: string;
    rating: number;
    body: string;
    hidden: boolean;
    created_at: Date | null;
  }>(
    `SELECT r.id, r.property_id, p.name AS property_name, r.author_name, r.rating, r.body, r.hidden, r.created_at
       FROM review r
       JOIN property p ON p.id = r.property_id
      WHERE p.host_id = $1
      ORDER BY r.created_at DESC NULLS LAST
      LIMIT 100`,
    [hostId],
    { label: "admin.hostProfile.reviews" },
  );

  const documentRows = await query<{
    id: string;
    status: string;
    document_kind: string | null;
    document_reference: string | null;
    document_files: string[] | null;
    notes: string | null;
    created_at: Date;
    decided_at: Date | null;
  }>(
    `SELECT user_id as id, status::text AS status, document_kind, document_reference, document_files, notes, created_at, decided_at
       FROM identity_verification
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20`,
    [hostId],
    { label: "admin.hostProfile.documents" },
  );

  const tripRows = await query<{
    id: string;
    reference: string;
    property_id: string;
    property_name: string;
    check_in: Date;
    check_out: Date;
    status: string;
    total_usd: string;
  }>(
    `SELECT b.id, b.reference, b.property_id, p.name AS property_name,
            b.check_in, b.check_out, b.status::text AS status, b.total_usd
       FROM booking b
       JOIN property p ON p.id = b.property_id
      WHERE b.guest_id = $1
      ORDER BY b.check_in DESC
      LIMIT 100`,
    [hostId],
    { label: "admin.hostProfile.trips" },
  );

  const earning = bookingRows.filter((row) => row.status === "confirmed" || row.status === "completed");
  const visibleReviews = reviewRows.filter((row) => !row.hidden);
  const ratingSum = visibleReviews.reduce((sum, row) => sum + row.rating, 0);

  return {
    host: {
      ...account,
      displayName: extra?.display_name ?? null,
      hostingSince: extra?.hosting_since ?? null,
      superhost: extra?.superhost ?? false,
      bannedReason: extra?.banned_reason ?? null,
      commissionRate: extra?.commission_rate === null || extra?.commission_rate === undefined
        ? null
        : Number(extra.commission_rate),
      defaultCommissionRate: Number(extra?.default_rate ?? 0),
      verificationStatus: (extra?.verification_status ?? "none") as "none" | "pending" | "verified" | "rejected",
      stripeIdentityStatus: extra?.stripe_identity_status ?? "not_connected",
      stripeRequirements: extra?.stripe_requirements ?? [],
      stripeCheckedAt: extra?.stripe_checked_at ? extra.stripe_checked_at.toISOString() : null,
    },
    totals: {
      listings: listingRows.length,
      publishedListings: listingRows.filter((row) => row.status === "published" && row.approved).length,
      bookings: bookingRows.length,
      completedBookings: bookingRows.filter((row) => row.status === "completed").length,
      cancelledBookings: bookingRows.filter((row) => row.status === "cancelled" || row.status === "declined").length,
      grossRevenueUsd: Number(earning.reduce((sum, row) => sum + Number(row.total_usd) / (Number(row.fx_rate_to_eur) || 1), 0).toFixed(2)),
      commissionUsd: Number(earning.reduce((sum, row) => sum + Number(row.service_fee) / (Number(row.fx_rate_to_eur) || 1), 0).toFixed(2)),
      averageRating: visibleReviews.length ? Number((ratingSum / visibleReviews.length).toFixed(2)) : 0,
      reviews: reviewRows.length,
    },
    listings: listingRows.map(mapListing),
    bookings: bookingRows.map((row) => ({
      id: row.id,
      reference: row.reference,
      propertyId: row.property_id,
      propertyName: row.property_name,
      guestName: row.guest_name,
      checkIn: row.check_in.toISOString().slice(0, 10),
      checkOut: row.check_out.toISOString().slice(0, 10),
      status: row.status,
      totalUsd: Number(row.total_usd),
      currency: row.currency.trim(),
    })),
    reviews: reviewRows.map((row) => ({
      id: row.id,
      propertyId: row.property_id,
      propertyName: row.property_name,
      authorName: row.author_name,
      rating: row.rating,
      body: row.body,
      hidden: row.hidden,
      createdAt: row.created_at ? row.created_at.toISOString() : null,
    })),
    documents: documentRows.map((row) => ({
      id: row.id,
      status: row.status,
      documentKind: row.document_kind,
      documentReference: row.document_reference,
      documentFiles: row.document_files,
      notes: row.notes,
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    })),
    trips: tripRows.map((row) => ({
      id: row.id,
      reference: row.reference,
      propertyId: row.property_id,
      propertyName: row.property_name,
      checkIn: row.check_in.toISOString().slice(0, 10),
      checkOut: row.check_out.toISOString().slice(0, 10),
      status: row.status,
      totalUsd: Number(row.total_usd),
    })),
  };
}

// --- payouts -----------------------------------------------------------------

export type PayoutDto = {
  id: string;
  hostId: string | null;
  hostName: string;
  amountUsd: number;
  commissionUsd: number;
  /** Currency of amountUsd/commissionUsd (the bookings' listing currency). */
  currency: string;
  status: "paid" | "scheduled";
  payoutDate: string;
  bookings: string[];
  createdAt: string;
  /** Stripe transfer reference, once the money has actually been sent. */
  transferId: string | null;
  paidAt: string | null;
};

type PayoutRow = {
  id: string;
  host_id: string | null;
  host_name: string;
  amount_usd: string;
  commission_usd: string;
  currency: string;
  status: "paid" | "scheduled";
  payout_date: Date;
  bookings: string[] | null;
  created_at: Date;
  stripe_transfer_id: string | null;
  paid_at: Date | null;
};

function mapPayout(row: PayoutRow): PayoutDto {
  return {
    id: row.id,
    hostId: row.host_id,
    hostName: row.host_name,
    amountUsd: Number(row.amount_usd),
    commissionUsd: Number(row.commission_usd),
    currency: (row.currency ?? "EUR").trim(),
    status: row.status,
    payoutDate: row.payout_date.toISOString().slice(0, 10),
    bookings: row.bookings ?? [],
    createdAt: row.created_at.toISOString(),
    transferId: row.stripe_transfer_id,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

const PAYOUT_SELECT = `
  SELECT p.id, p.host_id, p.host_name, p.amount_usd, p.commission_usd, p.currency, p.status::text AS status,
         p.payout_date, p.created_at, p.stripe_transfer_id, p.paid_at,
         (SELECT array_agg(i.booking_id ORDER BY i.booking_id) FROM payout_item i WHERE i.payout_id = p.id) AS bookings
    FROM payout p`;

export async function listPayouts(options: {
  hostId?: string;
  status?: "paid" | "scheduled";
  limit: number;
  offset: number;
}): Promise<{ items: PayoutDto[]; total: number; totalUsd: number; totalsByCurrency: Record<string, number> }> {
  const values: unknown[] = [];
  const where: string[] = [];

  if (options.hostId) {
    values.push(options.hostId);
    where.push(`p.host_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    where.push(`p.status = $${values.length}::payout_status`);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const countValues = [...values];
  values.push(options.limit, options.offset);

  const rows = await query<PayoutRow>(
    `${PAYOUT_SELECT} ${clause} ORDER BY p.payout_date DESC, p.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "admin.listPayouts" },
  );

  const totals = await queryOne<{ total: string; sum: string }>(
    `SELECT count(*) AS total, coalesce(sum(p.amount_usd), 0) AS sum FROM payout p ${clause}`,
    countValues,
    { label: "admin.countPayouts" },
  );

  const byCurrency = await query<{ currency: string; sum: string }>(
    `SELECT p.currency, coalesce(sum(p.amount_usd), 0) AS sum FROM payout p ${clause} GROUP BY p.currency`,
    countValues,
    { label: "admin.sumPayoutsByCurrency" },
  );
  const totalsByCurrency = Object.fromEntries(byCurrency.map((r) => [r.currency.trim(), Number(r.sum)]));

  return {
    items: rows.map(mapPayout),
    total: Number(totals?.total ?? 0),
    // Only meaningful when every payout shares one currency; use totalsByCurrency otherwise.
    totalUsd: Number(totals?.sum ?? 0),
    totalsByCurrency,
  };
}

/**
 * Groups every completed, not-yet-paid stay of a host into one payout.
 * The host share is the total minus the platform service fee.
 */
export async function createPayoutForHost(hostId: string, payoutDate?: string): Promise<PayoutDto> {
  return transaction(async (client) => {
    const host = await queryOne<{ display_name: string }>(
      `SELECT coalesce(hp.display_name, u.full_name) AS display_name
         FROM app_user u LEFT JOIN host_profile hp ON hp.user_id = u.id WHERE u.id = $1`,
      [hostId],
      { client, label: "admin.payoutHost" },
    );
    if (!host) {
      throw apiError("NOT_FOUND", { message: "That host does not exist.", details: { hostId } });
    }

    const eligibleAll = await query<{ id: string; total_usd: string; service_fee_usd: string; currency: string }>(
      `SELECT b.id, b.total_usd, b.service_fee AS service_fee_usd, b.currency
         FROM booking b
         JOIN property p ON p.id = b.property_id
        WHERE p.host_id = $1
          AND b.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM payout_item i WHERE i.booking_id = b.id)
          -- Stays already paid straight to the host at checkout are settled.
          AND NOT EXISTS (
            SELECT 1 FROM payment pay
             WHERE pay.booking_id = b.id
               AND pay.host_settled
               AND pay.status IN ('authorized', 'paid')
          )
        ORDER BY b.check_out`,
      [hostId],
      { client, label: "admin.payoutEligible" },
    );

    if (!eligibleAll.length) {
      throw apiError("PAYOUT_NOT_READY", {
        message: "This host has no completed stay waiting to be paid out.",
        details: { hostId },
      });
    }

    // A payout carries one currency. When a host has stays in several
    // currencies, the oldest currency is paid now and the rest stay eligible
    // for the next payout (the admin simply creates another one).
    const currency = eligibleAll[0]!.currency.trim();
    const eligible = eligibleAll.filter((row) => row.currency.trim() === currency);

    const commission = eligible.reduce((sum, row) => sum + Number(row.service_fee_usd), 0);
    const amount = eligible.reduce((sum, row) => sum + Number(row.total_usd) - Number(row.service_fee_usd), 0);
    const id = newPayoutId();

    await query(
      `INSERT INTO payout (id, host_id, host_name, amount_usd, commission_usd, currency, status, payout_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', coalesce($7::date, CURRENT_DATE))`,
      [id, hostId, host.display_name, amount.toFixed(2), commission.toFixed(2), currency, payoutDate ?? null],
      { client, label: "admin.createPayout" },
    );

    for (const booking of eligible) {
      await query(
        `INSERT INTO payout_item (payout_id, booking_id, amount_usd) VALUES ($1, $2, $3)`,
        [id, booking.id, (Number(booking.total_usd) - Number(booking.service_fee_usd)).toFixed(2)],
        { client, label: "admin.createPayoutItem" },
      );
    }

    const row = await queryOne<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1`, [id], {
      client,
      label: "admin.readPayout",
    });
    return mapPayout(row!);
  }, "admin.createPayout");
}

export async function markPayoutPaid(payoutId: string): Promise<PayoutDto> {
  const current = await queryOne<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1`, [payoutId], {
    label: "admin.readPayout",
  });
  if (!current) {
    throw apiError("NOT_FOUND", { message: "That payout does not exist.", details: { payoutId } });
  }
  if (current.status === "paid") {
    throw apiError("CONFLICT", { message: "This payout has already been marked as paid.", details: { payoutId } });
  }

  // Send the money first: a Stripe failure must never leave the register
  // claiming the host was paid. Returns null when Stripe is not configured,
  // in which case the payout stays a bookkeeping-only record.
  const transferId = await transferPayoutToHost({
    payoutId,
    hostId: current.host_id,
    amountUsd: Number(current.amount_usd),
    currency: current.currency,
  });

  await query(
    `UPDATE payout
        SET status = 'paid',
            paid_at = now(),
            stripe_transfer_id = COALESCE($2, stripe_transfer_id)
      WHERE id = $1`,
    [payoutId, transferId],
    { label: "admin.markPayoutPaid" },
  );
  const row = await queryOne<PayoutRow>(`${PAYOUT_SELECT} WHERE p.id = $1`, [payoutId], {
    label: "admin.readPayout",
  });
  return mapPayout(row!);
}

// --- reports -----------------------------------------------------------------

export type AdminReports = {
  monthly: { month: string; bookings: number; revenueUsd: number; commissionUsd: number }[];
  topListings: { propertyId: string; name: string; bookings: number; revenueUsd: number; rating: number }[];
  topHosts: { hostId: string; hostName: string; listings: number; revenueUsd: number }[];
  cancellations: { reason: string; count: number; refundedUsd: number }[];
};

export async function adminReports(months = 12): Promise<AdminReports> {
  const monthly = await query<{ month: string; bookings: string; revenue: string; commission: string }>(
    `SELECT to_char(date_trunc('month', b.created_at), 'YYYY-MM') AS month,
            count(*) AS bookings,
            coalesce(sum(b.total_usd / nullif(b.fx_rate_to_eur, 0)) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue,
            coalesce(sum(b.service_fee / nullif(b.fx_rate_to_eur, 0)) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS commission
       FROM booking b
      WHERE b.created_at >= date_trunc('month', now()) - make_interval(months => $1)
      GROUP BY 1 ORDER BY 1`,
    [months],
    { label: "admin.reports.monthly" },
  );

  const topListings = await query<{
    property_id: string;
    name: string;
    bookings: string;
    revenue: string;
    rating: string | null;
  }>(
    `SELECT p.id AS property_id, p.name, count(b.id) AS bookings,
            coalesce(sum(b.total_usd / nullif(b.fx_rate_to_eur, 0)) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue,
            p.rating
       FROM property p
       LEFT JOIN booking b ON b.property_id = p.id
      GROUP BY p.id, p.name, p.rating
      ORDER BY revenue DESC, bookings DESC
      LIMIT 10`,
    [],
    { label: "admin.reports.topListings" },
  );

  const topHosts = await query<{ host_id: string; host_name: string; listings: string; revenue: string }>(
    `SELECT u.id AS host_id, coalesce(hp.display_name, u.full_name) AS host_name,
            count(DISTINCT p.id) AS listings,
            coalesce(sum(b.total_usd / nullif(b.fx_rate_to_eur, 0)) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue
       FROM app_user u
       JOIN property p ON p.host_id = u.id
       LEFT JOIN host_profile hp ON hp.user_id = u.id
       LEFT JOIN booking b ON b.property_id = p.id
      GROUP BY u.id, coalesce(hp.display_name, u.full_name)
      ORDER BY revenue DESC
      LIMIT 10`,
    [],
    { label: "admin.reports.topHosts" },
  );

  const cancellations = await query<{ reason: string | null; count: string; refunded: string }>(
    `SELECT coalesce(nullif(trim(c.reason), ''), 'Not given') AS reason,
            count(*) AS count, coalesce(sum(c.refund_usd / nullif(bk.fx_rate_to_eur, 0)), 0) AS refunded
       FROM booking_cancellation c
       JOIN booking bk ON bk.id = c.booking_id
      GROUP BY 1 ORDER BY count DESC LIMIT 10`,
    [],
    { label: "admin.reports.cancellations" },
  );

  return {
    monthly: monthly.map((row) => ({
      month: row.month,
      bookings: Number(row.bookings),
      revenueUsd: Number(row.revenue),
      commissionUsd: Number(row.commission),
    })),
    topListings: topListings.map((row) => ({
      propertyId: row.property_id,
      name: row.name,
      bookings: Number(row.bookings),
      revenueUsd: Number(row.revenue),
      rating: row.rating ? Number(row.rating) : 0,
    })),
    topHosts: topHosts.map((row) => ({
      hostId: row.host_id,
      hostName: row.host_name,
      listings: Number(row.listings),
      revenueUsd: Number(row.revenue),
    })),
    cancellations: cancellations.map((row) => ({
      reason: row.reason ?? "Not given",
      count: Number(row.count),
      refundedUsd: Number(row.refunded),
    })),
  };
}

// --- statistics: occupancy, average basket, signups, destinations, season ----

export type AdminInsights = {
  months: number;
  occupancy: { rate: number; nightsBooked: number; nightsAvailable: number };
  averageBasketUsd: number;
  basketBookings: number;
  monthlyOccupancy: { month: string; rate: number; nightsBooked: number; nightsAvailable: number }[];
  signups: { month: string; total: number; hosts: number; guests: number }[];
  topDestinations: { city: string; country: string; bookings: number; revenueUsd: number; nights: number }[];
  seasonality: { month: number; label: string; bookings: number; nights: number; revenueUsd: number }[];
};

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The figures the specification asks for in the statistics tab. Everything is
 * computed over the last `months` calendar months, apart from seasonality,
 * which deliberately looks at the whole history to expose the yearly shape.
 *
 * Occupancy compares the nights actually sold with the nights that were on
 * sale: a listing only counts for the months after it was approved, and a stay
 * is clipped to the month it overlaps so a long booking is split correctly.
 */
export async function adminInsights(months = 12): Promise<AdminInsights> {
  const occupancy = await query<{
    month: string;
    nights_booked: string;
    nights_available: string;
  }>(
    `WITH span AS (
        SELECT generate_series(
                 date_trunc('month', now()) - make_interval(months => $1::int - 1),
                 date_trunc('month', now()),
                 interval '1 month')::date AS start
      ), bounds AS (
        SELECT start, (start + interval '1 month')::date AS stop FROM span
      )
      SELECT to_char(b.start, 'YYYY-MM') AS month,
             coalesce((SELECT sum(least(bk.check_out, b.stop) - greatest(bk.check_in, b.start))
                         FROM booking bk
                        WHERE bk.status IN ('confirmed','completed')
                          AND bk.check_in < b.stop AND bk.check_out > b.start), 0)::text AS nights_booked,
             coalesce((SELECT sum(b.stop - greatest(b.start, date(l.created_at)))
                         FROM listing l
                        WHERE l.approved AND date(l.created_at) < b.stop), 0)::text AS nights_available
        FROM bounds b
       ORDER BY 1`,
    [months],
    { label: "admin.insights.occupancy" },
  );

  const basket = await queryOne<{ average: string | null; bookings: string }>(
    `SELECT avg(total_usd / nullif(fx_rate_to_eur, 0)) AS average, count(*) AS bookings
       FROM booking
      WHERE status IN ('confirmed','completed')
        AND created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)`,
    [months],
    { label: "admin.insights.basket" },
  );

  const signups = await query<{ month: string; total: string; hosts: string; guests: string }>(
    `SELECT to_char(date_trunc('month', u.created_at), 'YYYY-MM') AS month,
            count(*) AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM user_role_grant g
                                            WHERE g.user_id = u.id AND g.role = 'host')) AS hosts,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM user_role_grant g
                                                WHERE g.user_id = u.id AND g.role IN ('host','admin'))) AS guests
       FROM app_user u
      WHERE u.created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
      GROUP BY 1 ORDER BY 1`,
    [months],
    { label: "admin.insights.signups" },
  );

  const destinations = await query<{
    city: string;
    country: string;
    bookings: string;
    revenue: string;
    nights: string;
  }>(
    `SELECT p.city, p.country, count(b.id) AS bookings,
            coalesce(sum(b.total_usd / nullif(b.fx_rate_to_eur, 0)), 0) AS revenue,
            coalesce(sum(b.nights), 0)::text AS nights
       FROM booking b
       JOIN property p ON p.id = b.property_id
      WHERE b.status IN ('confirmed','completed')
        AND b.created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
      GROUP BY p.city, p.country
      ORDER BY revenue DESC, bookings DESC
      LIMIT 10`,
    [months],
    { label: "admin.insights.destinations" },
  );

  const seasonality = await query<{ month: string; bookings: string; nights: string; revenue: string }>(
    `SELECT extract(month FROM check_in)::int::text AS month,
            count(*) AS bookings,
            coalesce(sum(nights), 0)::text AS nights,
            coalesce(sum(total_usd / nullif(fx_rate_to_eur, 0)), 0) AS revenue
       FROM booking
      WHERE status IN ('confirmed','completed')
      GROUP BY 1 ORDER BY 1`,
    [],
    { label: "admin.insights.seasonality" },
  );

  const monthlyOccupancy = occupancy.map((row) => {
    const booked = Number(row.nights_booked);
    const available = Number(row.nights_available);
    return {
      month: row.month,
      nightsBooked: booked,
      nightsAvailable: available,
      rate: available > 0 ? Number(((booked / available) * 100).toFixed(1)) : 0,
    };
  });
  const bookedTotal = monthlyOccupancy.reduce((sum, row) => sum + row.nightsBooked, 0);
  const availableTotal = monthlyOccupancy.reduce((sum, row) => sum + row.nightsAvailable, 0);

  const seasonByMonth = new Map(seasonality.map((row) => [Number(row.month), row]));

  return {
    months,
    occupancy: {
      nightsBooked: bookedTotal,
      nightsAvailable: availableTotal,
      rate: availableTotal > 0 ? Number(((bookedTotal / availableTotal) * 100).toFixed(1)) : 0,
    },
    averageBasketUsd: basket?.average ? Number(Number(basket.average).toFixed(2)) : 0,
    basketBookings: Number(basket?.bookings ?? 0),
    monthlyOccupancy,
    signups: signups.map((row) => ({
      month: row.month,
      total: Number(row.total),
      hosts: Number(row.hosts),
      guests: Number(row.guests),
    })),
    topDestinations: destinations.map((row) => ({
      city: row.city,
      country: row.country,
      bookings: Number(row.bookings),
      revenueUsd: Number(row.revenue),
      nights: Number(row.nights),
    })),
    seasonality: MONTH_LABELS.map((label, index) => {
      const row = seasonByMonth.get(index + 1);
      return {
        month: index + 1,
        label,
        bookings: Number(row?.bookings ?? 0),
        nights: Number(row?.nights ?? 0),
        revenueUsd: Number(row?.revenue ?? 0),
      };
    }),
  };
}
