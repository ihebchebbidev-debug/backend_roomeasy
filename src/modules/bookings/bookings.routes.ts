import { Router } from "express";
import { z } from "zod";

import { apiError } from "@/core/errors.js";
import { asyncHandler, created, ok } from "@/core/http.js";
import { isoDate, queryBoolean, validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser, isAdmin, requireAuth } from "@/middleware/auth.js";
import {
  assertBookingAccess,
  cancelBooking,
  checkAvailability,
  createBooking,
  decideBooking,
  listGuestBookings,
  listHostBookings,
  quoteStay,
} from "@/modules/bookings/bookings.repository.js";

export const bookingsRouter = Router();

const bookingParams = z.object({ bookingId: z.string().trim().min(1).max(140) });

const rangeSchema = z
  .object({
    propertyId: z.string().trim().min(1).max(120),
    from: isoDate,
    to: isoDate,
    guests: z.coerce.number().int().min(1).max(64).optional(),
    isMobile: queryBoolean(),
  })
  .refine((value) => value.to > value.from, {
    message: "Check-out must be after check-in.",
    path: ["to"],
  });

/** Can these nights be booked, and if not, why. Open to guests without an account. */
bookingsRouter.get(
  "/availability",
  asyncHandler(async (req, res) => {
    const input = validateQuery(rangeSchema, req);
    return ok(res, await checkAvailability(input));
  }),
);

/** Authoritative price for a set of nights. */
bookingsRouter.get(
  "/quote",
  asyncHandler(async (req, res) => {
    const input = validateQuery(rangeSchema, req);
    const { quote } = await quoteStay(input);
    return ok(res, { propertyId: input.propertyId, from: input.from, to: input.to, ...quote });
  }),
);

/**
 * Checkout. Booking requires an account: the guest must be signed in so the
 * stay, its payment and its confirmation page all belong to a real member.
 */
bookingsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = validateBody(
      z
        .object({
          propertyId: z.string().trim().min(1).max(120),
          from: isoDate,
          to: isoDate,
          guests: z.number().int().min(1).max(64),
          isMobile: z.boolean().optional(),
          message: z.string().trim().max(2000).optional(),
          guest: z.object({
            name: z.string().trim().min(2, "Enter the guest's full name.").max(120),
            email: z.string().trim().email("Enter a valid email address.").max(160).optional(),
            phone: z.string().trim().max(40).optional(),
          }),
          /** Omitted when the guest pays with Stripe: the card is collected by Stripe itself. */
          card: z
            .object({
              number: z.string().trim().min(12, "Enter the full card number.").max(24),
              name: z.string().trim().min(2, "Enter the name printed on the card.").max(120),
              expiry: z.string().trim().regex(/^\d{2}\/\d{2}$/, "Use the MM/YY format."),
              cvc: z.string().trim().regex(/^\d{3,4}$/, "The security code is 3 or 4 digits."),
            })
            .optional(),
          paymentMethod: z.enum(["card", "stripe"]).optional(),
        })
        .refine((value) => value.to > value.from, { message: "Check-out must be after check-in.", path: ["to"] }),
      req,
    );

    const user = currentUser(req);
    const booking = await createBooking({
      propertyId: body.propertyId,
      from: body.from,
      to: body.to,
      guests: body.guests,
      guest: body.guest,
      message: body.message ?? null,
      ...(body.paymentMethod === "stripe" || !body.card ? {} : { card: body.card }),
      isMobile: body.isMobile ?? false,
      guestId: user.userId,
    });

    req.log.info(
      { bookingId: booking.id, reference: booking.reference, status: booking.status, totalUsd: booking.price.totalUsd },
      "booking created",
    );
    return created(res, booking);
  }),
);

bookingsRouter.use(requireAuth);

/** The signed-in guest's trips. */
bookingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        scope: z.enum(["upcoming", "past", "all"]).default("all"),
        status: z
          .string()
          .optional()
          .transform((value) => (value ? value.split(",").map((part) => part.trim()) : undefined))
          .pipe(z.array(z.enum(["pending", "confirmed", "declined", "cancelled", "completed"])).optional()),
      }),
      req,
    );
    const items = await listGuestBookings(currentUser(req).userId, input);
    return ok(res, items, { total: items.length, scope: input.scope });
  }),
);

/** Requests and stays across the signed-in host's listings. */
bookingsRouter.get(
  "/host",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        propertyId: z.string().trim().max(120).optional(),
        status: z
          .string()
          .optional()
          .transform((value) => (value ? value.split(",").map((part) => part.trim()) : undefined))
          .pipe(z.array(z.enum(["pending", "confirmed", "declined", "cancelled", "completed"])).optional()),
      }),
      req,
    );
    const items = await listHostBookings(currentUser(req).userId, input);
    return ok(res, items, { total: items.length });
  }),
);

bookingsRouter.get(
  "/:bookingId",
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    const booking = await assertBookingAccess(bookingId, {
      userId: currentUser(req).userId,
      isAdmin: isAdmin(req),
    });
    return ok(res, booking);
  }),
);

/** Host accepts or declines a pending request. */
bookingsRouter.post(
  "/:bookingId/decision",
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    const body = validateBody(z.object({ decision: z.enum(["confirmed", "declined"]) }), req);
    const booking = await decideBooking({
      bookingId,
      decision: body.decision,
      actorId: currentUser(req).userId,
      isAdmin: isAdmin(req),
    });
    req.log.info({ bookingId, decision: body.decision }, "booking decided");
    return ok(res, booking);
  }),
);

/** Cancellation. The refund follows the stay's policy. */
bookingsRouter.post(
  "/:bookingId/cancel",
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    const body = validateBody(z.object({ reason: z.string().trim().max(500).optional() }), req);
    const user = currentUser(req);

    const booking = await assertBookingAccess(bookingId, { userId: user.userId, isAdmin: isAdmin(req) });
    const actorRole = isAdmin(req)
      ? "admin"
      : booking.guestId === user.userId
        ? "guest"
        : booking.hostId === user.userId
          ? "host"
          : null;
    if (!actorRole) throw apiError("FORBIDDEN", { message: "This booking belongs to someone else." });

    const result = await cancelBooking({ bookingId, actorId: user.userId, actorRole, reason: body.reason ?? null });
    req.log.info({ bookingId, actorRole, refundUsd: result.refund.amountUsd }, "booking cancelled");
    return ok(res, result);
  }),
);
