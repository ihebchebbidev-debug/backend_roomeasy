import { apiError } from "@/core/errors.js";
import { query, queryOne } from "@/db/query.js";
import { refundThroughStripe } from "@/modules/payments/refunds.js";

// --- bookings ----------------------------------------------------------------

type BookingRow = {
  id: string;
  reference: string;
  status: string;
  property_id: string;
  property_name: string | null;
  guest_id: string | null;
  guest_name: string;
  guest_email: string | null;
  host_id: string | null;
  host_name: string | null;
  check_in: Date;
  check_out: Date;
  total_usd: string;
  refunded_usd: string | null;
  policy: string | null;
};

const selectBooking = `
  SELECT b.id, b.reference, b.status, b.property_id, p.name AS property_name,
         b.guest_id, b.guest_name, b.guest_email, p.host_id, hu.full_name AS host_name,
         b.check_in, b.check_out, b.total_usd,
         (SELECT coalesce(sum(amount_usd), 0) FROM booking_refund r WHERE r.booking_id = b.id)::text AS refunded_usd,
         p.cancellation_policy::text AS policy
    FROM booking b
    LEFT JOIN property p ON p.id = b.property_id
    LEFT JOIN app_user hu ON hu.id = p.host_id`;

function mapBooking(row: BookingRow) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    propertyId: row.property_id,
    propertyName: row.property_name,
    guestId: row.guest_id,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    hostId: row.host_id,
    hostName: row.host_name,
    checkIn: row.check_in.toISOString().slice(0, 10),
    checkOut: row.check_out.toISOString().slice(0, 10),
    totalUsd: Number(row.total_usd),
    refundedUsd: Number(row.refunded_usd ?? 0),
    policy: row.policy,
  };
}

async function loadBooking(bookingId: string) {
  // The back office may hold either the internal id or the human reference.
  const row = await queryOne<BookingRow>(
    `${selectBooking} WHERE b.id::text = $1 OR b.reference = $1 LIMIT 1`,
    [bookingId],
    { label: "adminOps.loadBooking" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That booking does not exist." });
  return mapBooking(row);
}

/** Forced cancellation by an administrator, with an optional refund percentage. */
export async function adminCancelBooking(input: {
  bookingId: string;
  reason: string;
  refundPercent: number;
  adminId: string;
}) {
  const booking = await loadBooking(input.bookingId);
  if (booking.status === "cancelled") {
    throw apiError("NOT_CANCELLABLE", { message: "This booking is already cancelled." });
  }

  const refundUsd = Math.round(booking.totalUsd * input.refundPercent) / 100;

  // Send the money back through Stripe first: if it fails, nothing in our own
  // tables claims the guest was refunded.
  await refundThroughStripe(booking.id, refundUsd);



  await query("UPDATE booking SET status = 'cancelled', decided_at = now(), decided_by = $2 WHERE id = $1", [
    booking.id,
    input.adminId,
  ], { label: "adminOps.cancelBooking" });

  await query(
    `INSERT INTO booking_cancellation (booking_id, cancelled_by, cancelled_by_id, policy, refund_percent, refund_usd, reason)
     VALUES ($1, 'admin', $2, coalesce($3::cancellation_policy, 'moderate'), $4, $5, $6)
     ON CONFLICT (booking_id) DO UPDATE
        SET cancelled_by = 'admin', cancelled_by_id = $2, refund_percent = $4, refund_usd = $5, reason = $6,
            cancelled_at = now()`,
    [booking.id, input.adminId, booking.policy, input.refundPercent, refundUsd, input.reason],
    { label: "adminOps.cancellationRow" },
  );

  if (refundUsd > 0) {
    await query(
      `INSERT INTO booking_refund (booking_id, amount_usd, reason, issued_by) VALUES ($1, $2, $3, $4)`,
      [booking.id, refundUsd, input.reason, input.adminId],
      { label: "adminOps.cancelRefund" },
    );
    await query("UPDATE payment SET refunded_usd = refunded_usd + $2, status = 'refunded' WHERE booking_id = $1", [
      booking.id,
      refundUsd,
    ], { label: "adminOps.paymentRefund" });
  }

  return { ...(await loadBooking(booking.id)), refundUsd };
}

/** Manual full or partial refund without cancelling the stay. */
export async function refundBooking(input: {
  bookingId: string;
  amountUsd: number;
  reason: string;
  adminId: string;
}) {
  const booking = await loadBooking(input.bookingId);
  const remaining = booking.totalUsd - booking.refundedUsd;
  if (input.amountUsd > remaining + 0.001) {
    throw apiError("VALIDATION_FAILED", {
      message: `At most ${remaining.toFixed(2)} USD can still be refunded on this booking.`,
    });
  }

  // Real money moves first; the audit row is only written once Stripe agrees.
  await refundThroughStripe(booking.id, input.amountUsd);

  await query(
    "INSERT INTO booking_refund (booking_id, amount_usd, reason, issued_by) VALUES ($1, $2, $3, $4)",
    [booking.id, input.amountUsd, input.reason, input.adminId],
    { label: "adminOps.refund" },
  );
  await query(
    `UPDATE payment
        SET refunded_usd = refunded_usd + $2,
            status = CASE WHEN refunded_usd + $2 >= amount_usd THEN 'refunded'::payment_status ELSE status END
      WHERE booking_id = $1`,
    [booking.id, input.amountUsd],
    { label: "adminOps.refundPayment" },
  );

  return loadBooking(booking.id);
}

/** Exceptional change of dates or total, logged like every other admin action. */
export async function adjustBooking(input: {
  bookingId: string;
  checkIn?: string;
  checkOut?: string;
  totalUsd?: number;
  adminId: string;
}) {
  const target = await loadBooking(input.bookingId);
  await query(
    `UPDATE booking
        SET check_in = coalesce($2::date, check_in),
            check_out = coalesce($3::date, check_out),
            total_usd = coalesce($4::numeric, total_usd),
            decided_by = $5,
            decided_at = now()
      WHERE id = $1`,
    [target.id, input.checkIn ?? null, input.checkOut ?? null, input.totalUsd ?? null, input.adminId],
    { label: "adminOps.adjustBooking" },
  );
  return loadBooking(target.id);
}

export async function listBookingRefunds(bookingId: string) {
  const rows = await query<{ id: string; amount_usd: string; reason: string; created_at: Date; admin_name: string | null }>(
    `SELECT r.id, r.amount_usd, r.reason, r.created_at, u.full_name AS admin_name
       FROM booking_refund r
       LEFT JOIN app_user u ON u.id = r.issued_by
      WHERE r.booking_id = $1
      ORDER BY r.created_at DESC`,
    [bookingId],
    { label: "adminOps.refunds" },
  );
  return rows.map((row) => ({
    id: row.id,
    amountUsd: Number(row.amount_usd),
    reason: row.reason,
    adminName: row.admin_name,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Everything an administrator needs on one booking, including its history. */
export async function bookingAuditTrail(bookingId: string) {
  const booking = await loadBooking(bookingId);
  const refunds = await listBookingRefunds(booking.id);
  const log = await query<{
    action: string;
    reason: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
    admin_name: string | null;
  }>(
    `SELECT m.action, m.reason, m.metadata, m.created_at, u.full_name AS admin_name
       FROM moderation_log m
       LEFT JOIN app_user u ON u.id = m.admin_id
      WHERE m.target_kind = 'booking' AND m.target_id = $1
      ORDER BY m.created_at DESC`,
    [booking.id],
    { label: "adminOps.bookingLog" },
  );

  return {
    booking,
    refunds,
    history: log.map((row) => ({
      action: row.action,
      reason: row.reason,
      metadata: row.metadata,
      adminName: row.admin_name,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

// --- identity verification ---------------------------------------------------

export type VerificationStatus = "pending" | "verified" | "rejected";

export async function listVerifications(options: { limit: number; offset: number; status?: VerificationStatus }) {
  const rows = await query<{
    user_id: string;
    full_name: string;
    email: string;
    status: VerificationStatus | null;
    document_kind: string | null;
    notes: string | null;
    decided_at: Date | null;
    verified: boolean;
  }>(
    `SELECT u.id AS user_id, u.full_name, u.email, v.status, v.document_kind, v.notes, v.decided_at, u.verified
       FROM app_user u
       LEFT JOIN identity_verification v ON v.user_id = u.id
      WHERE ($3::verification_status IS NULL OR v.status = $3::verification_status)
        AND ($3::verification_status IS NOT NULL OR v.user_id IS NOT NULL OR u.verified = false)
      ORDER BY coalesce(v.updated_at, u.created_at) DESC
      LIMIT $1 OFFSET $2`,
    [options.limit, options.offset, options.status ?? null],
    { label: "adminOps.listVerifications" },
  );

  return rows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    status: row.status ?? (row.verified ? "verified" : "pending"),
    documentKind: row.document_kind,
    notes: row.notes,
    decidedAt: row.decided_at?.toISOString() ?? null,
    accountVerified: row.verified,
  }));
}

export async function setVerification(input: {
  userId: string;
  status: VerificationStatus;
  notes?: string | null;
  documentKind?: string | null;
  adminId: string;
}) {
  const row = await queryOne<{ user_id: string }>(
    `INSERT INTO identity_verification (user_id, status, document_kind, notes, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE
        SET status = $2,
            document_kind = coalesce($3, identity_verification.document_kind),
            notes = coalesce($4, identity_verification.notes),
            decided_by = $5,
            decided_at = now()
     RETURNING user_id`,
    [input.userId, input.status, input.documentKind ?? null, input.notes ?? null, input.adminId],
    { label: "adminOps.setVerification" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That account does not exist." });

  await query("UPDATE app_user SET verified = $2 WHERE id = $1", [input.userId, input.status === "verified"], {
    label: "adminOps.syncVerified",
  });

  return { userId: input.userId, status: input.status };
}

// --- hard ban ----------------------------------------------------------------

export async function setUserBanned(input: {
  userId: string;
  banned: boolean;
  reason?: string | null;
  adminId: string;
}) {
  const row = await queryOne<{ id: string; email: string; full_name: string; banned: boolean }>(
    `UPDATE app_user
        SET banned = $2,
            banned_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
            banned_at = CASE WHEN $2 THEN now() ELSE NULL END,
            -- Lifting a ban also lifts the suspension it caused, so the member
            -- can sign in again straight away.
            suspended = CASE WHEN $2 THEN true ELSE false END,
            suspended_reason = CASE WHEN $2 THEN coalesce($3, suspended_reason) ELSE NULL END,
            -- A ban never expires on its own, so it carries no end date.
            suspended_until = NULL
      WHERE id = $1
      RETURNING id, email, full_name, banned`,
    [input.userId, input.banned, input.reason ?? null],
    { label: "adminOps.setBanned" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That account does not exist." });

  // Banning a host takes every live listing offline; lifting the ban puts the
  // approved ones back. Listings the host had left as drafts stay drafts.
  const affected = input.banned
    ? await query<{ id: string }>(
        `UPDATE listing l
            SET status = 'suspended', updated_at = now()
           FROM property p
          WHERE p.id = l.property_id AND p.host_id = $1 AND l.status = 'published'
        RETURNING l.id`,
        [input.userId],
        { label: "adminOps.banUnpublishListings" },
      )
    : await query<{ id: string }>(
        `UPDATE listing l
            SET status = 'published', updated_at = now()
           FROM property p
          WHERE p.id = l.property_id AND p.host_id = $1 AND l.status = 'suspended' AND l.approved
        RETURNING l.id`,
        [input.userId],
        { label: "adminOps.unbanRestoreListings" },
      );

  return {
    userId: row.id,
    email: row.email,
    fullName: row.full_name,
    banned: row.banned,
    listingsAffected: affected.length,
  };
}

// --- per-host commission ------------------------------------------------------

export async function listHostCommissions(options: { limit: number; offset: number }) {
  const rows = await query<{
    host_id: string;
    host_name: string;
    email: string;
    commission_rate: string | null;
    note: string | null;
    updated_at: Date | null;
    default_rate: string;
  }>(
    `SELECT h.user_id AS host_id, u.full_name AS host_name, u.email,
            c.commission_rate, c.note, c.updated_at,
            (SELECT commission_rate FROM platform_settings WHERE id = true)::text AS default_rate
       FROM host_profile h
       JOIN app_user u ON u.id = h.user_id
       LEFT JOIN host_commission c ON c.host_id = h.user_id
      ORDER BY (c.commission_rate IS NULL), u.full_name
      LIMIT $1 OFFSET $2`,
    [options.limit, options.offset],
    { label: "adminOps.listCommissions" },
  );

  return rows.map((row) => ({
    hostId: row.host_id,
    hostName: row.host_name,
    email: row.email,
    commissionRate: row.commission_rate === null ? null : Number(row.commission_rate),
    defaultRate: Number(row.default_rate),
    effectiveRate: Number(row.commission_rate ?? row.default_rate),
    note: row.note,
    updatedAt: row.updated_at?.toISOString() ?? null,
  }));
}

export async function setHostCommission(input: {
  hostId: string;
  commissionRate: number | null;
  note?: string | null;
  adminId: string;
}) {
  if (input.commissionRate === null) {
    await query("DELETE FROM host_commission WHERE host_id = $1", [input.hostId], {
      label: "adminOps.clearCommission",
    });
    return { hostId: input.hostId, commissionRate: null };
  }

  const row = await queryOne<{ host_id: string; commission_rate: string }>(
    `INSERT INTO host_commission (host_id, commission_rate, note, set_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (host_id) DO UPDATE
        SET commission_rate = $2, note = coalesce($3, host_commission.note), set_by = $4
     RETURNING host_id, commission_rate`,
    [input.hostId, input.commissionRate, input.note ?? null, input.adminId],
    { label: "adminOps.setCommission" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That host does not exist." });
  return { hostId: row.host_id, commissionRate: Number(row.commission_rate) };
}

/** The rate applied to a host: their override, otherwise the platform rate. */
export async function effectiveCommissionRate(hostId: string): Promise<number> {
  const row = await queryOne<{ rate: string }>(
    `SELECT coalesce((SELECT commission_rate FROM host_commission WHERE host_id = $1),
                     (SELECT commission_rate FROM platform_settings WHERE id = true))::text AS rate`,
    [hostId],
    { label: "adminOps.effectiveRate" },
  );
  return Number(row?.rate ?? 0);
}
