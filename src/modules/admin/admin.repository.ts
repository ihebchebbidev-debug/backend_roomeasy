import { apiError } from "@/core/errors.js";
import { payoutId as newPayoutId } from "@/core/ids.js";
import { query, queryOne, transaction } from "@/db/query.js";
import type { Role } from "@/middleware/auth.js";

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
            coalesce(sum(total_usd) FILTER (WHERE status IN ('confirmed','completed')), 0) AS gross,
            coalesce(sum(service_fee) FILTER (WHERE status IN ('confirmed','completed')), 0) AS commission
       FROM booking`,
    [],
    { label: "admin.overview.bookings" },
  );

  const payouts = await queryOne<{ paid: string; pending: string }>(
    `SELECT coalesce(sum(amount_usd) FILTER (WHERE status = 'paid'), 0) AS paid,
            coalesce(sum(amount_usd) FILTER (WHERE status = 'scheduled'), 0) AS pending
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
  joinedOn: string;
  lastLoginAt: string | null;
  bookings: number;
  listings: number;
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
  const values: unknown[] = [];
  const where: string[] = [];

  if (options.userId) {
    values.push(options.userId);
    where.push(`u.id = $${values.length}`);
  }
  if (options.search?.trim()) {
    values.push(`%${options.search.trim()}%`);
    where.push(`(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length})`);
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
    joined_on: Date;
    last_login_at: Date | null;
    bookings: string;
    listings: string;
  }>(
    `SELECT u.id, u.full_name, u.email, u.phone, u.verified, u.suspended, u.suspended_reason,
            u.joined_on, u.last_login_at,
            (SELECT array_agg(g.role::text) FROM user_role_grant g WHERE g.user_id = u.id) AS roles,
            (SELECT count(*) FROM booking b WHERE b.guest_id = u.id) AS bookings,
            (SELECT count(*) FROM property p WHERE p.host_id = u.id) AS listings
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
      joinedOn: row.joined_on.toISOString().slice(0, 10),
      lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
      bookings: Number(row.bookings),
      listings: Number(row.listings),
    })),
    total: Number(total?.total ?? 0),
  };
}

/** Suspends or restores an account. An admin cannot suspend their own login. */
export async function setUserSuspended(input: {
  userId: string;
  suspended: boolean;
  reason?: string | null;
  actingAdminId: string;
}): Promise<AdminUserRow> {
  if (input.userId === input.actingAdminId && input.suspended) {
    throw apiError("CONFLICT", { message: "You cannot suspend your own administrator account." });
  }

  const rows = await query<{ id: string }>(
    `UPDATE app_user SET suspended = $2, suspended_reason = $3, updated_at = now() WHERE id = $1 RETURNING id`,
    [input.userId, input.suspended, input.suspended ? (input.reason ?? null) : null],
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

// --- payouts -----------------------------------------------------------------

export type PayoutDto = {
  id: string;
  hostId: string | null;
  hostName: string;
  amountUsd: number;
  commissionUsd: number;
  status: "paid" | "scheduled";
  payoutDate: string;
  bookings: string[];
  createdAt: string;
};

type PayoutRow = {
  id: string;
  host_id: string | null;
  host_name: string;
  amount_usd: string;
  commission_usd: string;
  status: "paid" | "scheduled";
  payout_date: Date;
  bookings: string[] | null;
  created_at: Date;
};

function mapPayout(row: PayoutRow): PayoutDto {
  return {
    id: row.id,
    hostId: row.host_id,
    hostName: row.host_name,
    amountUsd: Number(row.amount_usd),
    commissionUsd: Number(row.commission_usd),
    status: row.status,
    payoutDate: row.payout_date.toISOString().slice(0, 10),
    bookings: row.bookings ?? [],
    createdAt: row.created_at.toISOString(),
  };
}

const PAYOUT_SELECT = `
  SELECT p.id, p.host_id, p.host_name, p.amount_usd, p.commission_usd, p.status::text AS status,
         p.payout_date, p.created_at,
         (SELECT array_agg(i.booking_id ORDER BY i.booking_id) FROM payout_item i WHERE i.payout_id = p.id) AS bookings
    FROM payout p`;

export async function listPayouts(options: {
  hostId?: string;
  status?: "paid" | "scheduled";
  limit: number;
  offset: number;
}): Promise<{ items: PayoutDto[]; total: number; totalUsd: number }> {
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

  return {
    items: rows.map(mapPayout),
    total: Number(totals?.total ?? 0),
    totalUsd: Number(totals?.sum ?? 0),
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

    const eligible = await query<{ id: string; total_usd: string; service_fee_usd: string }>(
      `SELECT b.id, b.total_usd, b.service_fee AS service_fee_usd
         FROM booking b
         JOIN property p ON p.id = b.property_id
        WHERE p.host_id = $1
          AND b.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM payout_item i WHERE i.booking_id = b.id)
        ORDER BY b.check_out`,
      [hostId],
      { client, label: "admin.payoutEligible" },
    );

    if (!eligible.length) {
      throw apiError("PAYOUT_NOT_READY", {
        message: "This host has no completed stay waiting to be paid out.",
        details: { hostId },
      });
    }

    const commission = eligible.reduce((sum, row) => sum + Number(row.service_fee_usd), 0);
    const amount = eligible.reduce((sum, row) => sum + Number(row.total_usd) - Number(row.service_fee_usd), 0);
    const id = newPayoutId();

    await query(
      `INSERT INTO payout (id, host_id, host_name, amount_usd, commission_usd, status, payout_date)
       VALUES ($1, $2, $3, $4, $5, 'scheduled', coalesce($6::date, CURRENT_DATE))`,
      [id, hostId, host.display_name, amount.toFixed(2), commission.toFixed(2), payoutDate ?? null],
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

  await query(`UPDATE payout SET status = 'paid' WHERE id = $1`, [payoutId], { label: "admin.markPayoutPaid" });
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
            coalesce(sum(b.total_usd) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue,
            coalesce(sum(b.service_fee) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS commission
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
            coalesce(sum(b.total_usd) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue,
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
            coalesce(sum(b.total_usd) FILTER (WHERE b.status IN ('confirmed','completed')), 0) AS revenue
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
            count(*) AS count, coalesce(sum(c.refund_usd), 0) AS refunded
       FROM booking_cancellation c
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
