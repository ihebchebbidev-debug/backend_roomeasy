import { apiError } from "@/core/errors.js";
import { teamMemberId } from "@/core/ids.js";
import { query, queryOne } from "@/db/query.js";

export type HostProfileDto = {
  userId: string;
  displayName: string;
  hostingSince: number;
  superhost: boolean;
  bio: string | null;
  responseRate: number | null;
  payoutsOnboarded: boolean;
  payoutReference: string | null;
};

type HostProfileRow = {
  user_id: string;
  display_name: string;
  hosting_since: number;
  superhost: boolean;
  bio: string | null;
  response_rate: string | null;
  payouts_onboarded: boolean;
  payout_reference: string | null;
};

function mapHost(row: HostProfileRow): HostProfileDto {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    hostingSince: row.hosting_since,
    superhost: row.superhost,
    bio: row.bio,
    responseRate: row.response_rate === null ? null : Number(row.response_rate),
    payoutsOnboarded: row.payouts_onboarded,
    payoutReference: row.payout_reference,
  };
}

/**
 * A host profile must exist before a listing can point at it. Called on the
 * first listing save so an account upgraded to host never hits a foreign-key
 * error.
 */
export async function ensureHostProfile(userId: string, displayName?: string): Promise<HostProfileDto> {
  const row = await queryOne<HostProfileRow>(
    `INSERT INTO host_profile (user_id, display_name)
     VALUES ($1, coalesce($2, (SELECT coalesce(nullif(trim(full_name), ''), split_part(email, '@', 1))
                                 FROM app_user WHERE id = $1), 'Host'))
     ON CONFLICT (user_id) DO UPDATE SET display_name = coalesce($2, host_profile.display_name), updated_at = now()
     RETURNING user_id, display_name, hosting_since, superhost, bio, response_rate,
               payouts_onboarded, payout_reference`,
    [userId, displayName ?? null],
    { label: "host.ensureProfile" },
  );

  if (!row) {
    throw apiError("INTERNAL", { message: "The host profile could not be created. Try again." });
  }
  return mapHost(row);
}

export async function findHostProfile(userId: string): Promise<HostProfileDto | null> {
  const row = await queryOne<HostProfileRow>(
    `SELECT user_id, display_name, hosting_since, superhost, bio, response_rate,
            payouts_onboarded, payout_reference
       FROM host_profile WHERE user_id = $1`,
    [userId],
    { label: "host.findProfile" },
  );
  return row ? mapHost(row) : null;
}

export async function updateHostProfile(
  userId: string,
  patch: { displayName?: string; bio?: string | null; hostingSince?: number },
): Promise<HostProfileDto> {
  await ensureHostProfile(userId);
  const row = await queryOne<HostProfileRow>(
    `UPDATE host_profile SET
       display_name  = coalesce($2, display_name),
       bio           = coalesce($3, bio),
       hosting_since = coalesce($4, hosting_since),
       updated_at    = now()
     WHERE user_id = $1
     RETURNING user_id, display_name, hosting_since, superhost, bio, response_rate,
               payouts_onboarded, payout_reference`,
    [userId, patch.displayName ?? null, patch.bio ?? null, patch.hostingSince ?? null],
    { label: "host.updateProfile" },
  );
  return mapHost(row!);
}

/** Marks payout onboarding complete; required before a payout can be requested. */
export async function setPayoutOnboarding(
  userId: string,
  input: { onboarded: boolean; reference?: string | null },
): Promise<HostProfileDto> {
  await ensureHostProfile(userId);
  const row = await queryOne<HostProfileRow>(
    `UPDATE host_profile SET payouts_onboarded = $2, payout_reference = $3, updated_at = now()
      WHERE user_id = $1
      RETURNING user_id, display_name, hosting_since, superhost, bio, response_rate,
                payouts_onboarded, payout_reference`,
    [userId, input.onboarded, input.reference ?? null],
    { label: "host.setPayoutOnboarding" },
  );
  return mapHost(row!);
}

// ---------------------------------------------------------------------------
// Dashboard figures
// ---------------------------------------------------------------------------

export type HostDashboard = {
  listings: { total: number; published: number; awaitingApproval: number; drafts: number; suspended: number };
  bookings: { pending: number; upcoming: number; staying: number; completed: number; cancelled: number };
  earnings: { grossUsd: number; netUsd: number; pendingPayoutUsd: number; paidOutUsd: number };
  reviews: { count: number; averageRating: number; awaitingReply: number };
  messages: { openThreads: number; unread: number };
  occupancy: { nightsBooked: number; nightsAvailable: number; ratePercent: number };
};

/**
 * Everything the host dashboard shows, in one round trip per group.
 * `grossUsd` counts confirmed and completed stays only — a pending request is
 * not money yet.
 */
export async function hostDashboard(hostId: string, window = 90): Promise<HostDashboard> {
  const listings = await queryOne<{
    total: string;
    published: string;
    awaiting: string;
    drafts: string;
    suspended: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE l.status = 'published' AND l.approved)::text AS published,
            count(*) FILTER (WHERE l.status = 'published' AND NOT l.approved)::text AS awaiting,
            count(*) FILTER (WHERE l.status = 'draft')::text AS drafts,
            count(*) FILTER (WHERE l.status = 'suspended')::text AS suspended
       FROM listing l JOIN property p ON p.id = l.property_id
      WHERE p.host_id = $1`,
    [hostId],
    { label: "host.dashboard.listings" },
  );

  const bookings = await queryOne<{
    pending: string;
    upcoming: string;
    staying: string;
    completed: string;
    cancelled: string;
    gross: string;
  }>(
    `SELECT count(*) FILTER (WHERE b.status = 'pending')::text AS pending,
            count(*) FILTER (WHERE b.status = 'confirmed' AND b.check_in > CURRENT_DATE)::text AS upcoming,
            count(*) FILTER (WHERE b.status = 'confirmed'
                             AND b.check_in <= CURRENT_DATE AND b.check_out > CURRENT_DATE)::text AS staying,
            count(*) FILTER (WHERE b.status = 'completed')::text AS completed,
            count(*) FILTER (WHERE b.status IN ('cancelled', 'declined'))::text AS cancelled,
            coalesce(sum(b.total_usd) FILTER (WHERE b.status IN ('confirmed', 'completed')), 0)::text AS gross
       FROM booking b JOIN property p ON p.id = b.property_id
      WHERE p.host_id = $1`,
    [hostId],
    { label: "host.dashboard.bookings" },
  );

  const payouts = await queryOne<{ pending: string; paid: string }>(
    `SELECT coalesce(sum(amount_usd) FILTER (WHERE status = 'scheduled'), 0)::text AS pending,
            coalesce(sum(amount_usd) FILTER (WHERE status = 'paid'), 0)::text AS paid
       FROM payout WHERE host_id = $1`,
    [hostId],
    { label: "host.dashboard.payouts" },
  );

  const reviews = await queryOne<{ count: string; average: string; awaiting: string }>(
    `SELECT count(*)::text AS count,
            coalesce(round(avg(r.rating)::numeric, 2), 0)::text AS average,
            count(*) FILTER (WHERE r.reply IS NULL)::text AS awaiting
       FROM review r JOIN property p ON p.id = r.property_id
      WHERE p.host_id = $1 AND r.hidden = false`,
    [hostId],
    { label: "host.dashboard.reviews" },
  );

  const messages = await queryOne<{ open_threads: string; unread: string }>(
    `SELECT count(*) FILTER (WHERE t.closed = false)::text AS open_threads,
            coalesce(sum((SELECT count(*) FROM message m
                           WHERE m.thread_id = t.id AND m.sender_id <> $1 AND m.read_at IS NULL)), 0)::text AS unread
       FROM message_thread t
      WHERE t.host_id = $1`,
    [hostId],
    { label: "host.dashboard.messages" },
  );

  const occupancy = await queryOne<{ nights_booked: string; listings: string }>(
    `SELECT coalesce(sum(
              least(b.check_out, CURRENT_DATE + $2::int) - greatest(b.check_in, CURRENT_DATE)
            ) FILTER (WHERE b.status IN ('confirmed', 'completed')
                        AND b.check_out > CURRENT_DATE
                        AND b.check_in < CURRENT_DATE + $2::int), 0)::text AS nights_booked,
            (SELECT count(*)::text FROM listing l JOIN property p2 ON p2.id = l.property_id
              WHERE p2.host_id = $1 AND l.status = 'published') AS listings
       FROM booking b JOIN property p ON p.id = b.property_id
      WHERE p.host_id = $1`,
    [hostId, window],
    { label: "host.dashboard.occupancy" },
  );

  const gross = Number(bookings?.gross ?? 0);
  const publishedListings = Number(occupancy?.listings ?? 0);
  const nightsAvailable = publishedListings * window;
  const nightsBooked = Number(occupancy?.nights_booked ?? 0);

  return {
    listings: {
      total: Number(listings?.total ?? 0),
      published: Number(listings?.published ?? 0),
      awaitingApproval: Number(listings?.awaiting ?? 0),
      drafts: Number(listings?.drafts ?? 0),
      suspended: Number(listings?.suspended ?? 0),
    },
    bookings: {
      pending: Number(bookings?.pending ?? 0),
      upcoming: Number(bookings?.upcoming ?? 0),
      staying: Number(bookings?.staying ?? 0),
      completed: Number(bookings?.completed ?? 0),
      cancelled: Number(bookings?.cancelled ?? 0),
    },
    earnings: {
      grossUsd: Number(gross.toFixed(2)),
      netUsd: Number((gross - Number(payouts?.paid ?? 0)).toFixed(2)),
      pendingPayoutUsd: Number(Number(payouts?.pending ?? 0).toFixed(2)),
      paidOutUsd: Number(Number(payouts?.paid ?? 0).toFixed(2)),
    },
    reviews: {
      count: Number(reviews?.count ?? 0),
      averageRating: Number(reviews?.average ?? 0),
      awaitingReply: Number(reviews?.awaiting ?? 0),
    },
    messages: {
      openThreads: Number(messages?.open_threads ?? 0),
      unread: Number(messages?.unread ?? 0),
    },
    occupancy: {
      nightsBooked,
      nightsAvailable,
      ratePercent: nightsAvailable ? Number(((nightsBooked / nightsAvailable) * 100).toFixed(1)) : 0,
    },
  };
}

/** Month-by-month earnings for the dashboard chart. */
export async function hostEarningsByMonth(hostId: string, months = 12) {
  const rows = await query<{ month: string; bookings: string; gross: string; nights: string }>(
    `SELECT to_char(date_trunc('month', b.check_in), 'YYYY-MM') AS month,
            count(*)::text AS bookings,
            coalesce(sum(b.total_usd), 0)::text AS gross,
            coalesce(sum(b.check_out - b.check_in), 0)::text AS nights
       FROM booking b JOIN property p ON p.id = b.property_id
      WHERE p.host_id = $1
        AND b.status IN ('confirmed', 'completed')
        AND b.check_in >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
      GROUP BY 1
      ORDER BY 1`,
    [hostId, months],
    { label: "host.earningsByMonth" },
  );

  return rows.map((row) => ({
    month: row.month,
    bookings: Number(row.bookings),
    grossUsd: Number(Number(row.gross).toFixed(2)),
    nights: Number(row.nights),
  }));
}

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

export type TeamMemberDto = { id: string; fullName: string; email: string; scopes: string[]; createdAt: string };

export async function listTeamMembers(hostId: string): Promise<TeamMemberDto[]> {
  const rows = await query<{
    id: string;
    full_name: string;
    email: string;
    scopes: string[];
    created_at: Date;
  }>(
    `SELECT id, full_name, email, scopes, created_at FROM host_team_member
      WHERE host_id = $1 ORDER BY created_at`,
    [hostId],
    { label: "host.listTeam" },
  );
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    scopes: row.scopes ?? [],
    createdAt: row.created_at.toISOString(),
  }));
}

export async function addTeamMember(input: {
  hostId: string;
  fullName: string;
  email: string;
  scopes: string[];
}): Promise<TeamMemberDto> {
  await ensureHostProfile(input.hostId);
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM host_team_member WHERE host_id = $1 AND lower(email) = lower($2)`,
    [input.hostId, input.email],
    { label: "host.teamDuplicate" },
  );
  if (existing) {
    throw apiError("CONFLICT", {
      message: `${input.email} is already on your team.`,
      details: { teamMemberId: existing.id },
    });
  }

  const row = await queryOne<{ id: string; full_name: string; email: string; scopes: string[]; created_at: Date }>(
    `INSERT INTO host_team_member (id, host_id, full_name, email, scopes)
     VALUES ($1, $2, $3, $4, $5::team_scope[])
     RETURNING id, full_name, email, scopes, created_at`,
    [teamMemberId(), input.hostId, input.fullName.trim(), input.email.trim().toLowerCase(), input.scopes],
    { label: "host.addTeamMember" },
  );

  return {
    id: row!.id,
    fullName: row!.full_name,
    email: row!.email,
    scopes: row!.scopes ?? [],
    createdAt: row!.created_at.toISOString(),
  };
}

export async function removeTeamMember(hostId: string, memberId: string): Promise<void> {
  const rows = await query(`DELETE FROM host_team_member WHERE host_id = $1 AND id = $2 RETURNING id`, [
    hostId,
    memberId,
  ], { label: "host.removeTeamMember" });
  if (!rows.length) {
    throw apiError("NOT_FOUND", { message: "That team member is not on your team.", details: { memberId } });
  }
}
