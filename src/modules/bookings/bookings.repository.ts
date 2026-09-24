import type { PoolClient } from "pg";

import { env } from "@/config/env.js";
import { daysBetween, stayNights, today } from "@/core/dates.js";
import { apiError } from "@/core/errors.js";
import { bookingId as newBookingId, bookingReference, paymentIntentReference } from "@/core/ids.js";
import { logger } from "@/core/logger.js";
import { query, queryOne, transaction } from "@/db/query.js";
import { refundFor, type CancellationPolicy } from "@/domain/cancellation.js";
import { authorizeCard, type CardInput } from "@/domain/cards.js";
import { computeQuote, smartRulesActive, type PriceBreakdown } from "@/domain/pricing.js";
import { normalizeSmartRules } from "@/domain/smartPricingRules.js";
import { calendarMap } from "@/modules/listings/calendar.repository.js";
import { capturePaymentForBooking, refundThroughStripe } from "@/modules/payments/refunds.js";

import { notifyBookingEvent } from "@/modules/notifications/bookingEmails.js";
import { getHostRateRules, getPlatformSettings } from "@/modules/settings/settings.repository.js";

export type BookingStatus = "pending" | "confirmed" | "declined" | "cancelled" | "completed";

/**
 * A booking as the app's `Booking` model expects it (`src/models/booking.ts`):
 * `from` / `to`, a `price` shaped like `PriceBreakdown` and a `payment` with a
 * `method`. Everything else (property name and photo, host id, cleaning fee,
 * cancellation record) is extra detail the host and admin screens use; the
 * guest screens simply ignore it.
 *
 * `checkIn` / `checkOut` and the `*Usd` amounts are kept as aliases so both
 * naming styles work.
 */
export type BookingDto = {
  id: string;
  reference: string;
  propertyId: string;
  propertyName: string;
  propertyCity: string;
  propertyCountry: string;
  propertyPhoto: string | null;
  hostId: string | null;
  guestId: string | null;
  guest: { name: string; email: string | null; phone: string | null };
  message: string | null;
  /** ISO date, check-in. Same value as `checkIn`. */
  from: string;
  /** ISO date, check-out (exclusive). Same value as `checkOut`. */
  to: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  status: BookingStatus;
  isMobileBooking: boolean;
  currency: "EUR";
  price: {
    currency: "EUR";
    nightly: number;
    nights: number;
    baseSubtotal: number;
    discounts: { id: string; kind: string; percent: number; amount: number; amountUsd: number }[];
    subtotal: number;
    cleaningFee: number;
    serviceFee: number;
    taxes: number;
    total: number;
    /** Alias of `nightly`. */
    nightlyUsd: number;
    /** Alias of `total`. */
    totalUsd: number;
  };
  payment: {
    method: "card";
    brand: string;
    last4: string;
    status: string;
    reference: string;
    refundedUsd: number;
  } | null;
  cancellation: {
    cancelledBy: string;
    policy: string;
    refundPercent: number;
    refundUsd: number;
    reason: string | null;
    cancelledAt: string;
  } | null;
  cancellationPolicy: CancellationPolicy;
  createdAt: string;
  updatedAt: string;
};

type BookingRow = {
  id: string;
  reference: string;
  property_id: string;
  property_name: string;
  property_city: string;
  property_country: string;
  property_photo: string | null;
  host_id: string | null;
  cancellation_policy: CancellationPolicy;
  guest_id: string | null;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  message: string | null;
  check_in: Date | string;
  check_out: Date | string;
  guests: number;
  status: BookingStatus;
  is_mobile_booking: boolean;
  currency: string;
  nightly_usd: string;
  base_subtotal: string;
  subtotal: string;
  cleaning_fee: string;
  service_fee: string;
  taxes: string;
  total_usd: string;
  discounts: { kind: string; percent: string; amount_usd: string }[] | null;
  payment: { brand: string; last4: string; status: string; reference: string; refunded_usd: string } | null;
  cancellation: {
    cancelled_by: string;
    policy: string;
    refund_percent: string;
    refund_usd: string;
    reason: string | null;
    cancelled_at: string;
  } | null;
  created_at: Date;
  updated_at: Date;
};

const iso = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10));

const SELECT_BOOKING = `
  SELECT b.id, b.reference, b.property_id, p.name AS property_name, p.city AS property_city,
         p.country AS property_country, p.host_id, p.cancellation_policy,
         (SELECT url FROM property_photo ph WHERE ph.property_id = p.id ORDER BY ph.position LIMIT 1) AS property_photo,
         b.guest_id, b.guest_name, b.guest_email, b.guest_phone, b.message,
         b.check_in, b.check_out, b.guests, b.status, b.is_mobile_booking, b.currency,
         b.nightly_usd, b.base_subtotal, b.subtotal, b.cleaning_fee, b.service_fee, b.taxes, b.total_usd,
         (SELECT json_agg(json_build_object('kind', d.kind, 'percent', d.percent, 'amount_usd', d.amount_usd))
            FROM booking_discount d WHERE d.booking_id = b.id) AS discounts,
         (SELECT json_build_object('brand', pay.brand, 'last4', pay.last4, 'status', pay.status,
                                   'reference', pay.reference, 'refunded_usd', pay.refunded_usd)
            FROM payment pay WHERE pay.booking_id = b.id ORDER BY pay.created_at DESC LIMIT 1) AS payment,
         (SELECT json_build_object('cancelled_by', c.cancelled_by, 'policy', c.policy,
                                   'refund_percent', c.refund_percent, 'refund_usd', c.refund_usd,
                                   'reason', c.reason, 'cancelled_at', c.cancelled_at)
            FROM booking_cancellation c WHERE c.booking_id = b.id) AS cancellation,
         b.created_at, b.updated_at
    FROM booking b
    JOIN property p ON p.id = b.property_id`;

function mapBooking(row: BookingRow): BookingDto {
  const checkIn = iso(row.check_in);
  const checkOut = iso(row.check_out);
  const nights = daysBetween(checkIn, checkOut);
  const nightly = Number(row.nightly_usd);
  const total = Number(row.total_usd);
  return {
    id: row.id,
    reference: row.reference,
    propertyId: row.property_id,
    propertyName: row.property_name,
    propertyCity: row.property_city,
    propertyCountry: row.property_country,
    propertyPhoto: row.property_photo,
    hostId: row.host_id,
    guestId: row.guest_id,
    guest: { name: row.guest_name, email: row.guest_email, phone: row.guest_phone },
    message: row.message,
    from: checkIn,
    to: checkOut,
    checkIn,
    checkOut,
    nights,
    guests: row.guests,
    status: row.status,
    isMobileBooking: row.is_mobile_booking,
    currency: "EUR",
    price: {
      currency: "EUR",
      nightly,
      nights,
      baseSubtotal: Number(row.base_subtotal),
      subtotal: Number(row.subtotal),
      cleaningFee: Number(row.cleaning_fee),
      serviceFee: Number(row.service_fee),
      taxes: Number(row.taxes),
      total,
      nightlyUsd: nightly,
      totalUsd: total,
      discounts: (row.discounts ?? []).map((line) => ({
        id: line.kind,
        kind: line.kind,
        percent: Number(line.percent),
        amount: Number(line.amount_usd),
        amountUsd: Number(line.amount_usd),
      })),
    },
    payment: row.payment
      ? {
          method: "card",
          brand: row.payment.brand,
          last4: row.payment.last4,
          status: row.payment.status,
          reference: row.payment.reference,
          refundedUsd: Number(row.payment.refunded_usd),
        }
      : null,
    cancellation: row.cancellation
      ? {
          cancelledBy: row.cancellation.cancelled_by,
          policy: row.cancellation.policy,
          refundPercent: Number(row.cancellation.refund_percent),
          refundUsd: Number(row.cancellation.refund_usd),
          reason: row.cancellation.reason,
          cancelledAt: new Date(row.cancellation.cancelled_at).toISOString(),
        }
      : null,
    cancellationPolicy: row.cancellation_policy,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Stay lookup + availability
// ---------------------------------------------------------------------------

type StayRow = {
  property_id: string;
  host_id: string | null;
  name: string;
  guests: number;
  cleaning_fee_usd: string;
  min_nights: number;
  cancellation_policy: CancellationPolicy;
  instant_book: boolean;
  nightly_usd: string;
  status: string;
  approved: boolean;
  long_stay_enabled: boolean;
  long_stay_threshold: number;
  long_stay_discount: string;
  mobile_enabled: boolean;
  mobile_discount: string;
  smart_pricing_rules: unknown;
};

/** The live pricing + policy record a quote or booking is built from. */
export async function loadStay(propertyId: string, client?: PoolClient): Promise<StayRow> {
  const row = await queryOne<StayRow>(
    `SELECT p.id AS property_id, p.host_id, p.name, p.guests, p.cleaning_fee_usd, p.min_nights,
            p.cancellation_policy, p.instant_book,
            l.nightly_usd, l.status::text AS status, l.approved,
            l.long_stay_enabled, l.long_stay_threshold, l.long_stay_discount,
            l.mobile_enabled, l.mobile_discount, l.smart_pricing_rules
       FROM property p
       LEFT JOIN listing l ON l.property_id = p.id
      WHERE p.id = $1`,
    [propertyId],
    { client, label: "bookings.loadStay" },
  );

  if (!row) {
    throw apiError("NOT_FOUND", {
      message: `No stay exists with the id "${propertyId}".`,
      details: { propertyId },
    });
  }
  return row;
}

/**
 * Mirrors the app's `AvailabilityResult` model (`src/models/booking.ts`):
 * `propertyId`, `from`, `to`, `available`, `unavailableDates`, `maxGuests`.
 * The remaining fields are extra detail the host calendar and the error
 * messages use; a client may safely ignore them.
 */
export type AvailabilityResult = {
  propertyId: string;
  from: string;
  to: string;
  available: boolean;
  /** Every night in the range that cannot be booked — blocked or already taken. */
  unavailableDates: string[];
  maxGuests: number;
  nights: number;
  minNights: number;
  reasons: string[];
  blockedNights: string[];
  bookedNights: string[];
  conflictingBookings: string[];
};

/** Why a set of nights cannot be booked, in plain words the UI can show. */
export async function checkAvailability(input: {
  propertyId: string;
  from: string;
  to: string;
  guests?: number;
  ignoreBookingId?: string;
  client?: PoolClient;
}): Promise<AvailabilityResult> {
  // Release nights held by bookings that were never paid before reading the
  // calendar; skipped inside an open transaction to avoid lock contention.
  if (!input.client) await sweepExpiredHolds();

  // Every read uses the caller's connection when there is one, so a check run
  // inside a transaction sees one consistent snapshot.
  const stay = await loadStay(input.propertyId, input.client);

  const nights = stayNights(input.from, input.to);
  const reasons: string[] = [];

  if (!nights.length) reasons.push("Check-out must be at least one night after check-in.");
  if (input.from < today()) reasons.push("Check-in cannot be in the past.");
  if (nights.length && nights.length < stay.min_nights) {
    reasons.push(`This stay is booked for at least ${stay.min_nights} night(s).`);
  }
  if (input.guests !== undefined && input.guests > stay.guests) {
    reasons.push(`This stay hosts up to ${stay.guests} guest(s).`);
  }
  if (stay.status !== "published" || !stay.approved) {
    reasons.push("This stay is not currently open for bookings.");
  }

  const calendar = await calendarMap(input.propertyId, input.from, input.to, input.client);
  const blockedNights = nights.filter((night) => calendar[night]?.blocked);
  if (blockedNights.length) {
    reasons.push(`The host has blocked ${blockedNights.length} of those nights.`);
  }

  const conflicts = await query<{ reference: string; check_in: Date | string; check_out: Date | string }>(
    `SELECT reference, check_in, check_out FROM booking
      WHERE property_id = $1
        AND status IN ('pending', 'confirmed', 'completed')
        AND ($4::text IS NULL OR id <> $4)
        AND daterange(check_in, check_out, '[)') && daterange($2::date, $3::date, '[)')`,
    [input.propertyId, input.from, input.to, input.ignoreBookingId ?? null],
    { client: input.client, label: "bookings.conflicts" },
  );
  if (conflicts.length) reasons.push("Another booking already covers some of those nights.");

  // Nights already taken by another booking, expanded so the calendar can grey
  // them out one by one.
  const bookedNights = nights.filter((night) =>
    conflicts.some((row) => night >= iso(row.check_in) && night < iso(row.check_out)),
  );

  const unavailableDates = [...new Set([...blockedNights, ...bookedNights])].sort();

  return {
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    available: reasons.length === 0,
    nights: nights.length,
    minNights: stay.min_nights,
    maxGuests: stay.guests,
    reasons,
    blockedNights,
    bookedNights,
    unavailableDates,
    conflictingBookings: conflicts.map((row) => row.reference),
  };
}

/** Occupancy of the upcoming window and the nights of this stay that fill a short gap. */
async function smartContext(
  propertyId: string,
  from: string,
  to: string,
  rules: ReturnType<typeof normalizeSmartRules>,
) {
  let occupancyPercent: number | null = null;
  if (rules.occupancy.enabled) {
    const window = Math.max(1, rules.occupancy.windowDays);
    const row = await queryOne<{ taken: string }>(
      `SELECT count(DISTINCT d)::text AS taken
         FROM booking b, generate_series(CURRENT_DATE, CURRENT_DATE + ($2::int - 1), interval '1 day') d
        WHERE b.property_id = $1 AND b.status IN ('pending','confirmed')
          AND d >= b.check_in AND d < b.check_out`,
      [propertyId, window],
      { label: "bookings.smartOccupancy" },
    );
    occupancyPercent = Math.round((Number(row?.taken ?? 0) / window) * 100);
  }

  const gapNights = new Set<string>();
  if (rules.gapNight.enabled) {
    // The stay fills a gap when a booking ends exactly at check-in and another
    // starts exactly at check-out, and the stay is short enough.
    const nights = stayNights(from, to);
    if (nights.length <= rules.gapNight.maxGapNights) {
      const row = await queryOne<{ before: boolean; after: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM booking WHERE property_id = $1 AND status IN ('pending','confirmed') AND check_out = $2::date) AS before,
                EXISTS (SELECT 1 FROM booking WHERE property_id = $1 AND status IN ('pending','confirmed') AND check_in = $3::date) AS after`,
        [propertyId, from, to],
        { label: "bookings.smartGap" },
      );
      if (row?.before && row?.after) nights.forEach((night) => gapNights.add(night));
    }
  }
  return { rules, occupancyPercent, gapNights };
}

/** Server-side price for a set of nights. The client never sends a total. */
export async function quoteStay(input: {
  propertyId: string;
  from: string;
  to: string;
  guests?: number;
  isMobile?: boolean;
}): Promise<{ quote: PriceBreakdown; stay: StayRow }> {
  const stay = await loadStay(input.propertyId);
  const nights = stayNights(input.from, input.to);
  if (!nights.length) {
    throw apiError("INVALID_DATES", {
      issues: [{ field: "to", message: "Check-out must be after check-in." }],
      details: { from: input.from, to: input.to },
    });
  }
  if (nights.length < stay.min_nights) {
    throw apiError("MIN_NIGHTS_NOT_MET", {
      message: `This stay is booked for at least ${stay.min_nights} night(s); you chose ${nights.length}.`,
      details: { minNights: stay.min_nights, nights: nights.length },
    });
  }
  if (input.guests !== undefined && input.guests > stay.guests) {
    throw apiError("TOO_MANY_GUESTS", {
      message: `This stay hosts up to ${stay.guests} guest(s); you asked for ${input.guests}.`,
      details: { maxGuests: stay.guests, requested: input.guests },
    });
  }

  const [settings, rateRules, calendar] = await Promise.all([
    getPlatformSettings(),
    getHostRateRules(stay.host_id),
    calendarMap(input.propertyId, input.from, input.to),
  ]);

  const smartRules = normalizeSmartRules(stay.smart_pricing_rules);
  const smart = smartRulesActive(smartRules)
    ? await smartContext(input.propertyId, input.from, input.to, smartRules)
    : null;

  const quote = computeQuote({
    smart,
    from: input.from,
    to: input.to,
    nightlyUsd: Number(stay.nightly_usd),
    cleaningFeeUsd: Number(stay.cleaning_fee_usd),
    calendar,
    longStay: {
      enabled: stay.long_stay_enabled,
      threshold: stay.long_stay_threshold,
      discount: Number(stay.long_stay_discount),
    },
    mobile: { enabled: stay.mobile_enabled, discount: Number(stay.mobile_discount) },
    rateRules,
    serviceFeeRate: settings.serviceFeeRate,
    taxRate: settings.taxRate,
    isMobile: Boolean(input.isMobile),
  });

  return { quote, stay };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBooking(input: {
  propertyId: string;
  from: string;
  to: string;
  guests: number;
  guest: { name: string; email?: string | null; phone?: string | null };
  message?: string | null;
  /** Left out when the guest pays through Stripe; the payment row stays pending. */
  card?: CardInput;
  isMobile?: boolean;
  guestId: string | null;
}): Promise<BookingDto> {
  const { quote, stay } = await quoteStay({
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    guests: input.guests,
    isMobile: input.isMobile,
  });

  if (stay.host_id && input.guestId && stay.host_id === input.guestId) {
    throw apiError("OWN_PROPERTY_BOOKING");
  }
  if (input.from < today()) {
    throw apiError("DATES_IN_PAST", { details: { from: input.from, today: today() } });
  }

  const availability = await checkAvailability({
    propertyId: input.propertyId,
    from: input.from,
    to: input.to,
    guests: input.guests,
  });
  if (!availability.available) {
    throw apiError("UNAVAILABLE", {
      message: availability.reasons.join(" "),
      details: { reasons: availability.reasons, blockedNights: availability.blockedNights },
    });
  }

  // Card checks and the charge happen before the row is written, so a declined
  // card never leaves a half-created booking behind.
  const charge = input.card
    ? authorizeCard(input.card, quote.total)
    : { brand: "card" as const, last4: "0000" };
  // A Stripe booking is only confirmed once the webhook reports the payment.
  const paymentStatus = input.card ? "authorized" : "pending";

  const id = newBookingId();
  const reference = bookingReference();

  const row = await transaction(async (client) => {
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO booking (
         id, reference, property_id, guest_id, guest_name, guest_email, guest_phone, message,
         check_in, check_out, guests, status, is_mobile_booking, currency,
         nightly_usd, base_subtotal, subtotal, cleaning_fee, service_fee, taxes, total_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               $9::date, $10::date, $11, $12::booking_status, $13, 'USD',
               $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`,
      [
        id,
        reference,
        input.propertyId,
        input.guestId,
        input.guest.name.trim(),
        input.guest.email?.trim().toLowerCase() ?? null,
        input.guest.phone?.trim() ?? null,
        input.message?.trim() || null,
        input.from,
        input.to,
        input.guests,
        stay.instant_book && input.card ? "confirmed" : "pending",
        Boolean(input.isMobile),
        quote.nightly,
        quote.baseSubtotal,
        quote.subtotal,
        quote.cleaningFee,
        quote.serviceFee,
        quote.taxes,
        quote.total,
      ],
      { client, label: "bookings.insert" },
    );

    if (quote.discounts.length) {
      await query(
        `INSERT INTO booking_discount (booking_id, kind, percent, amount_usd)
         SELECT $1, kind::discount_kind, percent, amount
           FROM unnest($2::text[], $3::numeric[], $4::numeric[]) AS t(kind, percent, amount)`,
        [
          inserted!.id,
          quote.discounts.map((line) => line.id),
          quote.discounts.map((line) => line.percent),
          quote.discounts.map((line) => line.amount),
        ],
        { client, label: "bookings.insertDiscounts" },
      );
    }

    await query(
      `INSERT INTO payment (booking_id, method, brand, last4, status, amount_usd, reference)
       VALUES ($1, 'card', $2::card_brand, $3, $6::payment_status, $4, $5)`,
      [inserted!.id, charge.brand, charge.last4, quote.total, paymentIntentReference(), paymentStatus],
      { client, label: "bookings.insertPayment" },
    );

    const created = await queryOne<BookingRow>(`${SELECT_BOOKING} WHERE b.id = $1`, [inserted!.id], {
      client,
      label: "bookings.readAfterInsert",
    });
    return created!;
  }, "bookings.create");

  const created = mapBooking(row);
  // Stripe bookings are announced once the payment webhook reports the money.
  if (input.card) void notifyBookingEvent(created.id, created.status === "confirmed" ? "confirmed" : "created");
  return created;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function findBooking(bookingId: string): Promise<BookingDto | null> {
  const row = await queryOne<BookingRow>(`${SELECT_BOOKING} WHERE b.id = $1 OR b.reference = $1`, [bookingId], {
    label: "bookings.find",
  });
  return row ? mapBooking(row) : null;
}

/**
 * Guest and host lists are read straight into a screen, so they are capped:
 * without a limit a long-standing account would return every booking it ever
 * had in one response.
 */
const MAX_PAGE = 500;
const pageSize = (limit?: number) => Math.min(Math.max(1, limit ?? MAX_PAGE), MAX_PAGE);

/** The guest's own trips; `scope` splits upcoming from past. */
export async function listGuestBookings(
  guestId: string,
  options: { status?: BookingStatus[]; scope?: "upcoming" | "past" | "all"; limit?: number; offset?: number } = {},
): Promise<BookingDto[]> {
  const clauses = ["b.guest_id = $1"];
  const values: unknown[] = [guestId];

  if (options.status?.length) {
    values.push(options.status);
    clauses.push(`b.status = ANY($${values.length}::booking_status[])`);
  }
  if (options.scope === "upcoming") clauses.push("b.check_out >= CURRENT_DATE AND b.status IN ('pending', 'confirmed')");
  if (options.scope === "past") clauses.push("(b.check_out < CURRENT_DATE OR b.status IN ('completed', 'cancelled', 'declined'))");

  values.push(pageSize(options.limit), Math.max(0, options.offset ?? 0));
  const rows = await query<BookingRow>(
    `${SELECT_BOOKING} WHERE ${clauses.join(" AND ")} ORDER BY b.check_in DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "bookings.listForGuest" },
  );
  return rows.map(mapBooking);
}

/** Bookings across every listing of one host. */
export async function listHostBookings(
  hostId: string,
  options: { status?: BookingStatus[]; propertyId?: string; limit?: number; offset?: number } = {},
): Promise<BookingDto[]> {
  // Release nights held by checkouts that were abandoned before payment, so an
  // abandoned cart never shows up in the host's requests.
  await sweepExpiredHolds();

  const clauses = [
    "p.host_id = $1",
    // A pending request is only real once the guest has actually paid (or the
    // card was authorised); an unpaid pending row is a checkout in progress.
    `(b.status <> 'pending' OR EXISTS (
        SELECT 1 FROM payment pay
         WHERE pay.booking_id = b.id AND pay.status IN ('authorized', 'paid')))`,
  ];
  const values: unknown[] = [hostId];

  if (options.status?.length) {
    values.push(options.status);
    clauses.push(`b.status = ANY($${values.length}::booking_status[])`);
  }
  if (options.propertyId) {
    values.push(options.propertyId);
    clauses.push(`b.property_id = $${values.length}`);
  }

  values.push(pageSize(options.limit), Math.max(0, options.offset ?? 0));
  const rows = await query<BookingRow>(
    `${SELECT_BOOKING} WHERE ${clauses.join(" AND ")} ORDER BY b.check_in DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "bookings.listForHost" },
  );
  return rows.map(mapBooking);
}

/**
 * Admin list with paging, free-text search on reference / guest / stay and the
 * back-office filters from the admin specification: traveller, host, listing
 * and stay dates.
 */
export async function listAllBookings(options: {
  status?: BookingStatus[];
  search?: string;
  guest?: string;
  host?: string;
  listing?: string;
  /** Keeps stays that end on or after this ISO date. */
  from?: string;
  /** Keeps stays that start on or before this ISO date. */
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: BookingDto[]; total: number }> {
  const clauses: string[] = ["true"];
  const values: unknown[] = [];

  if (options.status?.length) {
    values.push(options.status);
    clauses.push(`b.status = ANY($${values.length}::booking_status[])`);
  }
  if (options.search?.trim()) {
    values.push(`%${options.search.trim()}%`);
    clauses.push(
      `(b.reference ILIKE $${values.length} OR b.guest_name ILIKE $${values.length}
        OR b.guest_email ILIKE $${values.length} OR p.name ILIKE $${values.length})`,
    );
  }
  if (options.guest?.trim()) {
    values.push(`%${options.guest.trim()}%`);
    clauses.push(`(b.guest_name ILIKE $${values.length} OR b.guest_email ILIKE $${values.length})`);
  }
  if (options.host?.trim()) {
    values.push(`%${options.host.trim()}%`);
    clauses.push(
      `EXISTS (SELECT 1 FROM app_user hu
                 LEFT JOIN host_profile hp ON hp.user_id = hu.id
                WHERE hu.id = p.host_id
                  AND (hu.full_name ILIKE $${values.length} OR hu.email ILIKE $${values.length}
                       OR hp.display_name ILIKE $${values.length}))`,
    );
  }
  if (options.listing?.trim()) {
    values.push(`%${options.listing.trim()}%`);
    clauses.push(`(p.name ILIKE $${values.length} OR p.id::text ILIKE $${values.length})`);
  }
  if (options.from) {
    values.push(options.from);
    clauses.push(`b.check_out >= $${values.length}::date`);
  }
  if (options.to) {
    values.push(options.to);
    clauses.push(`b.check_in <= $${values.length}::date`);
  }

  const where = clauses.join(" AND ");
  const total = await queryOne<{ total: string }>(
    `SELECT count(*)::text AS total FROM booking b JOIN property p ON p.id = b.property_id WHERE ${where}`,
    values,
    { label: "bookings.countAll" },
  );

  values.push(options.limit ?? 20, options.offset ?? 0);
  const rows = await query<BookingRow>(
    `${SELECT_BOOKING} WHERE ${where} ORDER BY b.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "bookings.listAll" },
  );

  return { items: rows.map(mapBooking), total: Number(total?.total ?? 0) };
}

/** Throws unless the caller is the guest, the host of the stay, or an admin. */
export async function assertBookingAccess(
  bookingId: string,
  actor: { userId: string; isAdmin: boolean },
): Promise<BookingDto> {
  const booking = await findBooking(bookingId);
  if (!booking) {
    throw apiError("NOT_FOUND", {
      message: `No booking exists with the reference "${bookingId}".`,
      details: { bookingId },
    });
  }
  const allowed = actor.isAdmin || booking.guestId === actor.userId || booking.hostId === actor.userId;
  if (!allowed) {
    throw apiError("FORBIDDEN", { message: "This booking belongs to someone else." });
  }
  return booking;
}

// ---------------------------------------------------------------------------
// Host decision, cancellation, completion
// ---------------------------------------------------------------------------




/** Host accepts or declines a pending request. */
export async function decideBooking(input: {
  bookingId: string;
  decision: "confirmed" | "declined";
  actorId: string;
  isAdmin: boolean;
}): Promise<BookingDto> {
  const booking = await assertBookingAccess(input.bookingId, { userId: input.actorId, isAdmin: input.isAdmin });

  if (!input.isAdmin && booking.hostId !== input.actorId) {
    throw apiError("FORBIDDEN", { message: "Only the host of this stay can answer the request." });
  }
  if (booking.status !== "pending") {
    throw apiError("BOOKING_NOT_PENDING", {
      message: `This request is already ${booking.status}.`,
      details: { status: booking.status },
    });
  }

  // Nothing is taken from the card before we know the nights are still free:
  // a first check here, and the authoritative one inside the transaction.
  if (input.decision === "confirmed") {
    const availability = await checkAvailability({
      propertyId: booking.propertyId,
      from: booking.checkIn,
      to: booking.checkOut,
      ignoreBookingId: booking.id,
    });
    if (availability.conflictingBookings.length) {
      throw apiError("UNAVAILABLE", {
        message: "Another confirmed booking now covers those nights.",
        details: { conflictingBookings: availability.conflictingBookings },
      });
    }
  }

  // A declined request gives the guest everything back — through Stripe first,
  // so the database is never marked "refunded" for money that never moved.
  if (input.decision === "declined") {
    await refundThroughStripe(booking.id, booking.price.totalUsd);
  } else {
    // Accepting is the moment the money is actually taken: until now it was
    // only held on the guest's card.
    await capturePaymentForBooking(booking.id);
  }

  const run = async () =>
    transaction(async (client) => {


    if (input.decision === "confirmed") {
      // Re-check now: another request may have taken the nights while pending.
      const availability = await checkAvailability({
        propertyId: booking.propertyId,
        from: booking.checkIn,
        to: booking.checkOut,
        ignoreBookingId: booking.id,
        client,
      });
      if (availability.conflictingBookings.length) {
        throw apiError("UNAVAILABLE", {
          message: "Another confirmed booking now covers those nights.",
          details: { conflictingBookings: availability.conflictingBookings },
        });
      }
    }

    await query(
      `UPDATE booking SET status = $2::booking_status, decided_at = now(), decided_by = $3, updated_at = now()
        WHERE id = $1`,
      [booking.id, input.decision, input.actorId],
      { client, label: "bookings.decide" },
    );

    if (input.decision === "declined") {
      await query(
        `INSERT INTO booking_cancellation (booking_id, cancelled_by, cancelled_by_id, policy, refund_percent, refund_usd, reason)
         VALUES ($1, 'host', $2, $3::cancellation_policy, 100, $4, 'Declined by the host')
         ON CONFLICT (booking_id) DO UPDATE
           SET cancelled_by = excluded.cancelled_by, cancelled_by_id = excluded.cancelled_by_id,
               refund_percent = excluded.refund_percent, refund_usd = excluded.refund_usd,
               reason = excluded.reason, cancelled_at = now()`,

        [booking.id, input.actorId, booking.cancellationPolicy, booking.price.totalUsd],
        { client, label: "bookings.declineRefund" },
      );
      await query(
        `UPDATE payment SET status = 'refunded', refunded_usd = amount_usd
         WHERE booking_id = $1 AND status IN ('authorized', 'paid')`,
        [booking.id],
        { client, label: "bookings.declineRefundPayment" },
      );
    }

    const updated = await queryOne<BookingRow>(`${SELECT_BOOKING} WHERE b.id = $1`, [booking.id], { client });
    return updated!;
  }, "bookings.decide");

  let row: BookingRow;
  try {
    row = await run();
  } catch (error) {
    // The money already moved. If writing the decision failed, put it back so
    // a guest is never charged for a stay that stayed pending.
    if (input.decision === "confirmed") {
      try {
        await refundThroughStripe(booking.id, booking.price.totalUsd);
      } catch (refundError) {
        logger.error(
          { bookingId: booking.id, err: refundError },
          "captured payment could not be refunded after a failed booking decision",
        );
      }
    }
    throw error;
  }

  void notifyBookingEvent(booking.id, input.decision);
  return mapBooking(row);
}

/**
 * Cancels a booking and records the refund the policy allows. A guest can only
 * cancel before check-out; host, admin and system cancellations refund in full.
 */
export async function cancelBooking(input: {
  bookingId: string;
  actorId: string;
  actorRole: "guest" | "host" | "admin" | "system";
  reason?: string | null;
}): Promise<BookingDto & { refund: { percent: number; amountUsd: number } }> {
  const booking = await findBooking(input.bookingId);
  if (!booking) {
    throw apiError("NOT_FOUND", { message: `No booking exists with the reference "${input.bookingId}".` });
  }

  if (input.actorRole === "guest" && booking.guestId !== input.actorId) {
    throw apiError("FORBIDDEN", { message: "This booking belongs to another guest." });
  }
  if (input.actorRole === "host" && booking.hostId !== input.actorId) {
    throw apiError("FORBIDDEN", { message: "This stay belongs to another host." });
  }
  if (!["pending", "confirmed"].includes(booking.status)) {
    throw apiError("NOT_CANCELLABLE", {
      message: `A ${booking.status} booking can no longer be cancelled.`,
      details: { status: booking.status },
    });
  }
  if (booking.checkOut <= today()) {
    throw apiError("NOT_CANCELLABLE", {
      message: "This stay has already finished.",
      details: { checkOut: booking.checkOut },
    });
  }

  const refund = refundFor({
    policy: booking.cancellationPolicy,
    checkIn: booking.checkIn,
    totalUsd: booking.price.totalUsd,
    cancelledBy: input.actorRole,
  });

  // Send the money back through Stripe before recording the refund, so the
  // payment row can never claim a refund the card never received.
  await refundThroughStripe(booking.id, refund.amountUsd);

  const row = await transaction(async (client) => {

    await query(`UPDATE booking SET status = 'cancelled', updated_at = now() WHERE id = $1`, [booking.id], {
      client,
      label: "bookings.cancel",
    });
    await query(
      `INSERT INTO booking_cancellation (booking_id, cancelled_by, cancelled_by_id, policy, refund_percent, refund_usd, reason)
       VALUES ($1, $2::actor_role, $3, $4::cancellation_policy, $5, $6, $7)
       ON CONFLICT (booking_id) DO UPDATE
         SET cancelled_by = excluded.cancelled_by, cancelled_by_id = excluded.cancelled_by_id,
             refund_percent = excluded.refund_percent, refund_usd = excluded.refund_usd,
             reason = excluded.reason, cancelled_at = now()`,
      [
        booking.id,
        input.actorRole,
        input.actorRole === "system" ? null : input.actorId,
        booking.cancellationPolicy,
        refund.percent,
        refund.amountUsd,
        input.reason?.trim() || null,
      ],
      { client, label: "bookings.cancellationRecord" },
    );

    if (refund.amountUsd > 0) {
      await query(
        `UPDATE payment SET status = 'refunded', refunded_usd = $2
         WHERE booking_id = $1 AND status IN ('authorized', 'paid')`,
        [booking.id, refund.amountUsd],
        { client, label: "bookings.refundPayment" },
      );
    }

    const updated = await queryOne<BookingRow>(`${SELECT_BOOKING} WHERE b.id = $1`, [booking.id], { client });
    return updated!;
  }, "bookings.cancel");

  if (input.actorRole !== "admin") void notifyBookingEvent(booking.id, `cancelled_by_${input.actorRole}`);
  return { ...mapBooking(row), refund: { percent: refund.percent, amountUsd: refund.amountUsd } };
}

/**
 * Moves finished confirmed stays to `completed`. Safe to call repeatedly — the
 * server runs it on start-up and once an hour.
 */
export async function completeFinishedStays(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE booking SET status = 'completed', updated_at = now()
      WHERE status = 'confirmed' AND check_out <= CURRENT_DATE
      RETURNING id`,
    [],
    { label: "bookings.completeFinished" },
  );
  if (rows.length) {
    await query(`UPDATE payment SET status = 'paid' WHERE booking_id = ANY($1::text[]) AND status = 'authorized'`, [
      rows.map((row) => row.id),
    ]);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Unpaid holds
// ---------------------------------------------------------------------------

/**
 * Releases the nights held by bookings that were never paid.
 *
 * A booking is created as `pending` with a `pending` payment row when the guest
 * chooses Stripe but never completes the checkout. Those nights stay blocked by
 * the overlap constraint, so after `BOOKING_HOLD_MINUTES` the booking is
 * cancelled (refund 0, actor `system`) and its payment row marked `failed`.
 *
 * Safe to call as often as needed: the update only matches rows that are still
 * pending and still unpaid.
 */
export async function expireUnpaidBookings(holdMinutes = env.BOOKING_HOLD_MINUTES): Promise<number> {
  return transaction(async (client) => {
    const expired = await query<{ id: string; reference: string; guest_id: string | null; guest_email: string | null }>(
      `UPDATE booking b
          SET status = 'cancelled', updated_at = now()
        WHERE b.status = 'pending'
          AND b.created_at < now() - ($1::int * interval '1 minute')
          AND NOT EXISTS (
                SELECT 1 FROM payment p
                 WHERE p.booking_id = b.id AND p.status IN ('authorized', 'paid'))
        RETURNING b.id, b.reference, b.guest_id, b.guest_email`,
      [holdMinutes],
      { client, label: "bookings.expireUnpaid" },
    );
    if (!expired.length) return 0;

    const ids = expired.map((row) => row.id);

    await query(
      `INSERT INTO booking_cancellation (booking_id, cancelled_by, cancelled_by_id, policy, refund_percent, refund_usd, reason)
       SELECT b.id, 'system'::actor_role, NULL, p.cancellation_policy, 0, 0,
              'Payment was not completed in time, so the dates were released.'
         FROM booking b JOIN property p ON p.id = b.property_id
        WHERE b.id = ANY($1::text[])
       ON CONFLICT (booking_id) DO NOTHING`,
      [ids],
      { client, label: "bookings.expireUnpaid.cancellations" },
    );

    await query(
      `UPDATE payment SET status = 'failed' WHERE booking_id = ANY($1::text[]) AND status = 'pending'`,
      [ids],
      { client, label: "bookings.expireUnpaid.payments" },
    );

    return expired.length;
  }, "bookings.expireUnpaid");
}

let lastSweepAt = 0;

/**
 * Cheap guard used on the read paths (availability, quote, checkout): runs the
 * sweep at most once every 30 seconds so a guest never sees nights held by a
 * booking that has already expired.
 */
export async function sweepExpiredHolds(): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < 30_000) return;
  lastSweepAt = now;
  await expireUnpaidBookings();
}
