import { Router } from "express";
import { z } from "zod";

import { apiError } from "@/core/errors.js";
import { asyncHandler, created, ok } from "@/core/http.js";
import { validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { sendXlsx } from "@/core/xlsx.js";
import { currentUser } from "@/middleware/auth.js";
import { requireCapability } from "@/middleware/permissions.js";
import { adminInsights, adminReports, setListingSuspended, setUserSuspended } from "@/modules/admin/admin.repository.js";
import { recordModeration } from "@/modules/admin/moderation.repository.js";
import { listNotifications, notificationCounts, queueNotification } from "@/modules/admin/notifications.repository.js";
import {
  adjustBooking,
  adminCancelBooking,
  bookingAuditTrail,
  listHostCommissions,
  listVerifications,
  refundBooking,
  setHostCommission,
  setUserBanned,
  setVerification,
} from "@/modules/admin/operations.repository.js";
import {
  accountingExport,
  bookingInvoice,
  commissionReport,
  financeLedger,
} from "@/modules/admin/finance.repository.js";
import { renderInvoicePdf } from "@/modules/admin/invoice.pdf.js";
import { dispatchQueuedEmails, requeueNotification } from "@/modules/notifications/dispatcher.js";
import { mailerStatus, verifyMailer } from "@/modules/notifications/mailer.js";
import { stripeStatus } from "@/modules/payments/stripe.client.js";
import { listListingReports, setReportStatus } from "@/modules/admin/reports.repository.js";
import {
  addTicketMessage,
  assignTicket,
  getTicket,
  listTickets,
  setTicketStatus,
} from "@/modules/admin/support.repository.js";

/**
 * Second half of the back office: listing reports, member verification and
 * bans, per-host commission, forced cancellations and refunds, the support
 * desk and the notification queue. Mounted inside `adminRouter`, so the
 * administrator-role check has already run.
 */
export const adminOperationsRouter = Router();

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const uuidParam = <K extends string>(key: K) =>
  z.object({ [key]: z.string().uuid("That identifier is not valid.") } as Record<K, z.ZodString>);

// --- listing reports ---------------------------------------------------------

adminOperationsRouter.get(
  "/listing-reports",
  requireCapability("listings.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({
        status: z.enum(["open", "reviewing", "resolved", "dismissed", "all"]).default("open"),
        listingId: z.string().trim().max(140).optional(),
      }),
      req,
    );
    const result = await listListingReports(input);
    return ok(res, result.items, {
      total: result.total,
      openCount: result.openCount,
      limit: input.limit,
      offset: input.offset,
    });
  }),
);

adminOperationsRouter.post(
  "/listing-reports/:reportId/status",
  requireCapability("listings.moderate"),
  asyncHandler(async (req, res) => {
    const { reportId } = validateParams(uuidParam("reportId"), req);
    const { status, resolution } = validateBody(
      z.object({
        status: z.enum(["open", "reviewing", "resolved", "dismissed"]),
        resolution: z.string().trim().max(600).optional(),
      }),
      req,
    );
    const admin = currentUser(req);
    const report = await setReportStatus({ reportId, status, resolution, adminId: admin.userId });
    if (status === "resolved" || status === "dismissed") {
      await recordModeration({
        adminId: admin.userId,
        action: status === "resolved" ? "listing_report_resolved" : "listing_report_dismissed",
        targetKind: "report",
        targetId: reportId,
        reason: resolution ?? null,
        metadata: { listingId: report.listingId },
      });
    }
    return ok(res, report);
  }),
);

/** Take a listing off the site with a reason; the host is notified. */
adminOperationsRouter.post(
  "/listings/:listingId/unpublish",
  requireCapability("listings.moderate"),
  asyncHandler(async (req, res) => {
    const { listingId } = validateParams(z.object({ listingId: z.string().trim().min(1).max(140) }), req);
    const { reason, reportId } = validateBody(
      z.object({
        reason: z.string().trim().min(5, "Tell the host why, in at least 5 characters.").max(600),
        reportId: z.string().uuid().optional(),
      }),
      req,
    );
    const admin = currentUser(req);
    const listing = await setListingSuspended(listingId, true);
    await recordModeration({
      adminId: admin.userId,
      action: "listing_suspended",
      targetKind: "listing",
      targetId: listingId,
      reason,
      metadata: reportId ? { reportId } : {},
    });
    if (reportId) {
      await setReportStatus({ reportId, status: "resolved", resolution: reason, adminId: admin.userId });
    }
    if (listing.hostId) {
      await queueNotification({
        recipientId: listing.hostId,
        template: "listing_suspended",
        subject: "Your listing has been taken offline",
        body: `An administrator has taken your listing offline. Reason: ${reason}`,
        payload: { listingId, reason },
      });
    }
    return ok(res, listing);
  }),
);

// --- members: verification & ban ---------------------------------------------

adminOperationsRouter.get(
  "/verifications",
  requireCapability("users.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({ status: z.enum(["pending", "verified", "rejected"]).optional() }),
      req,
    );
    return ok(res, await listVerifications(input));
  }),
);

adminOperationsRouter.post(
  "/users/:userId/verification",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(uuidParam("userId"), req);
    const { status, notes, documentKind } = validateBody(
      z.object({
        status: z.enum(["pending", "verified", "rejected"]),
        notes: z.string().trim().max(600).optional(),
        documentKind: z.string().trim().max(80).optional(),
      }),
      req,
    );
    const admin = currentUser(req);
    const result = await setVerification({ userId, status, notes, documentKind, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "user_verification_updated",
      targetKind: "user",
      targetId: userId,
      reason: notes ?? null,
      metadata: { status },
    });
    if (status !== "pending") {
      await queueNotification({
        recipientId: userId,
        template: status === "verified" ? "identity_verified" : "identity_rejected",
        subject: status === "verified" ? "Your identity is verified" : "We could not verify your identity",
        body:
          status === "verified"
            ? "Your identity has been verified. Your account is now fully active."
            : `We could not verify your identity. ${notes ?? "Please send a clearer document."}`,
        payload: { status },
      });
    }
    return ok(res, result);
  }),
);

adminOperationsRouter.post(
  "/users/:userId/ban",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(uuidParam("userId"), req);
    const { reason } = validateBody(
      z.object({ reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(600) }),
      req,
    );
    const admin = currentUser(req);
    const account = await setUserBanned({ userId, banned: true, reason, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "user_banned",
      targetKind: "user",
      targetId: userId,
      reason,
    });
    await queueNotification({
      recipientId: userId,
      recipientEmail: account.email,
      template: "account_banned",
      subject: "Your RoomEasy account has been closed",
      body: `An administrator has permanently closed your account. Reason: ${reason}`,
      payload: { reason },
    });
    req.log.warn({ userId, reason }, "account banned");
    return ok(res, account);
  }),
);

adminOperationsRouter.post(
  "/users/:userId/unban",
  requireCapability("users.manage"),
  asyncHandler(async (req, res) => {
    const { userId } = validateParams(uuidParam("userId"), req);
    const admin = currentUser(req);
    const account = await setUserBanned({ userId, banned: false, adminId: admin.userId });
    await recordModeration({ adminId: admin.userId, action: "user_unbanned", targetKind: "user", targetId: userId });
    return ok(res, account);
  }),
);

// --- per-host commission ------------------------------------------------------

adminOperationsRouter.get(
  "/commissions",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(pagination, req);
    return ok(res, await listHostCommissions(input));
  }),
);

adminOperationsRouter.put(
  "/commissions/:hostId",
  requireCapability("finance.manage"),
  asyncHandler(async (req, res) => {
    const { hostId } = validateParams(uuidParam("hostId"), req);
    const { commissionRate, note } = validateBody(
      z.object({
        commissionRate: z.number().min(0).max(100).nullable(),
        note: z.string().trim().max(300).optional(),
      }),
      req,
    );
    const admin = currentUser(req);
    const result = await setHostCommission({ hostId, commissionRate, note, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "commission_updated",
      targetKind: "commission",
      targetId: hostId,
      reason: note ?? null,
      metadata: { commissionRate },
    });
    await queueNotification({
      recipientId: hostId,
      template: "commission_updated",
      subject: "Your commission rate has changed",
      body:
        commissionRate === null
          ? "Your listings now use the standard platform commission."
          : `Your commission rate is now ${commissionRate}%.`,
      payload: { commissionRate },
    });
    return ok(res, result);
  }),
);

// --- bookings: forced cancellation, refunds, adjustments ----------------------

const bookingParams = z.object({ bookingId: z.string().trim().min(1).max(140) });

adminOperationsRouter.get(
  "/bookings/:bookingId/audit",
  requireCapability("bookings.read"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    return ok(res, await bookingAuditTrail(bookingId));
  }),
);

adminOperationsRouter.post(
  "/bookings/:bookingId/cancel",
  requireCapability("bookings.manage"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    const { reason, refundPercent } = validateBody(
      z.object({
        reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(600),
        refundPercent: z.number().min(0).max(100).default(100),
      }),
      req,
    );
    const admin = currentUser(req);
    const result = await adminCancelBooking({ bookingId, reason, refundPercent, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "booking_cancelled_admin",
      targetKind: "booking",
      targetId: bookingId,
      reason,
      metadata: { refundPercent, refundUsd: result.refundUsd },
    });
    if (result.guestId) {
      await queueNotification({
        recipientId: result.guestId,
        recipientEmail: result.guestEmail,
        template: "booking_cancelled_by_admin",
        subject: `Booking ${result.reference} has been cancelled`,
        body: `An administrator cancelled your booking. Reason: ${reason}. Refund: ${result.refundUsd} USD.`,
        payload: { bookingId, refundUsd: result.refundUsd },
      });
    }
    req.log.warn({ bookingId, reason, refundPercent }, "booking cancelled by admin");
    return ok(res, result);
  }),
);

adminOperationsRouter.post(
  "/bookings/:bookingId/refund",
  requireCapability("finance.manage"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    const { amountUsd, reason } = validateBody(
      z.object({
        amountUsd: z.number().positive("Enter an amount above zero."),
        reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(600),
      }),
      req,
    );
    const admin = currentUser(req);
    const booking = await refundBooking({ bookingId, amountUsd, reason, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "booking_refunded",
      targetKind: "booking",
      targetId: bookingId,
      reason,
      metadata: { amountUsd },
    });
    if (booking.guestId) {
      await queueNotification({
        recipientId: booking.guestId,
        recipientEmail: booking.guestEmail,
        template: "booking_refunded",
        subject: `A refund of ${amountUsd} USD has been issued`,
        body: `We refunded ${amountUsd} USD on booking ${booking.reference}. Reason: ${reason}`,
        payload: { bookingId, amountUsd },
      });
    }
    return created(res, booking);
  }),
);

adminOperationsRouter.post(
  "/bookings/:bookingId/adjust",
  requireCapability("bookings.manage"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(bookingParams, req);
    const input = validateBody(
      z
        .object({
          checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          totalUsd: z.number().min(0).optional(),
          reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(600),
        })
        .refine((value) => value.checkIn || value.checkOut || value.totalUsd !== undefined, {
          message: "Change at least the dates or the amount.",
        }),
      req,
    );
    const admin = currentUser(req);
    const booking = await adjustBooking({ ...input, bookingId, adminId: admin.userId });
    await recordModeration({
      adminId: admin.userId,
      action: "booking_modified",
      targetKind: "booking",
      targetId: bookingId,
      reason: input.reason,
      metadata: { checkIn: input.checkIn, checkOut: input.checkOut, totalUsd: input.totalUsd },
    });
    return ok(res, booking);
  }),
);

// --- support desk -------------------------------------------------------------

adminOperationsRouter.get(
  "/tickets",
  requireCapability("support.manage"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({
        status: z.enum(["open", "pending", "awaiting_reply", "escalated", "resolved", "closed", "all"]).default("open"),
        category: z.enum(["booking", "payment", "listing", "account", "dispute", "other", "review"]).optional(),
        assignedTo: z.string().uuid().optional(),
        search: z.string().trim().max(120).optional(),
      }),
      req,
    );
    const result = await listTickets(input);
    return ok(res, result.items, {
      total: result.total,
      openCount: result.openCount,
      limit: input.limit,
      offset: input.offset,
    });
  }),
);

adminOperationsRouter.get(
  "/tickets/:ticketId",
  requireCapability("support.manage"),
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(uuidParam("ticketId"), req);
    return ok(res, await getTicket(ticketId));
  }),
);

adminOperationsRouter.post(
  "/tickets/:ticketId/messages",
  requireCapability("support.manage"),
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(uuidParam("ticketId"), req);
    const { body, internalNote } = validateBody(
      z.object({
        body: z.string().trim().min(1, "Write a reply.").max(4000),
        internalNote: z.boolean().default(false),
      }),
      req,
    );
    const admin = currentUser(req);
    await addTicketMessage({
      ticketId,
      authorId: admin.userId,
      authorName: admin.email,
      authorRole: "admin",
      body,
      internalNote,
    });
    const ticket = await getTicket(ticketId);
    if (!internalNote && ticket.openedById) {
      await queueNotification({
        recipientId: ticket.openedById,
        recipientEmail: ticket.openedByEmail,
        template: "support_reply",
        subject: `Reply to your request ${ticket.reference}`,
        body,
        payload: { ticketId },
      });
    }
    return created(res, ticket);
  }),
);

adminOperationsRouter.post(
  "/tickets/:ticketId/assign",
  requireCapability("support.manage"),
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(uuidParam("ticketId"), req);
    const { adminId } = validateBody(z.object({ adminId: z.string().uuid().nullable() }), req);
    const admin = currentUser(req);
    const ticket = await assignTicket(ticketId, adminId);
    await recordModeration({
      adminId: admin.userId,
      action: "ticket_assigned",
      targetKind: "ticket",
      targetId: ticketId,
      metadata: { assignedTo: adminId },
    });
    return ok(res, ticket);
  }),
);

adminOperationsRouter.post(
  "/tickets/:ticketId/status",
  requireCapability("support.manage"),
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(uuidParam("ticketId"), req);
    const { status, resolution } = validateBody(
      z.object({
        status: z.enum(["open", "pending", "awaiting_reply", "escalated", "resolved", "closed"]),
        resolution: z.string().trim().max(600).optional(),
      }),
      req,
    );
    const admin = currentUser(req);
    const ticket = await setTicketStatus({ ticketId, status, resolution });
    await recordModeration({
      adminId: admin.userId,
      action: "ticket_status_changed",
      targetKind: "ticket",
      targetId: ticketId,
      reason: resolution ?? null,
      metadata: { status },
    });
    return ok(res, ticket);
  }),
);

/**
 * One-click actions from a ticket, as the specification asks: cancel the stay
 * with a refund, refund an amount, or suspend the member. The outcome is written
 * back into the conversation so the desk keeps a full trace.
 */
adminOperationsRouter.post(
  "/tickets/:ticketId/action",
  requireCapability("support.manage"),
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(uuidParam("ticketId"), req);
    const input = validateBody(
      z.discriminatedUnion("action", [
        z.object({
          action: z.literal("cancel_booking"),
          reason: z.string().trim().min(3).max(600),
          refundPercent: z.coerce.number().min(0).max(100).default(100),
        }),
        z.object({
          action: z.literal("refund_booking"),
          reason: z.string().trim().min(3).max(600),
          amountUsd: z.coerce.number().positive(),
        }),
        z.object({
          action: z.literal("suspend_member"),
          reason: z.string().trim().min(3).max(600),
          days: z.coerce.number().int().min(1).max(365).nullable().default(null),
        }),
      ]),
      req,
    );
    const admin = currentUser(req);
    const ticket = await getTicket(ticketId);

    let note: string;
    if (input.action === "suspend_member") {
      if (!ticket.openedById) {
        throw apiError("VALIDATION_FAILED", { message: "This ticket is not linked to a member account." });
      }
      const until = input.days
        ? new Date(Date.now() + input.days * 24 * 60 * 60 * 1000).toISOString()
        : null;
      await setUserSuspended({
        userId: ticket.openedById,
        suspended: true,
        reason: input.reason,
        until,
        actingAdminId: admin.userId,
      });
      note = until
        ? `Account suspended until ${until.slice(0, 10)} — ${input.reason}`
        : `Account suspended — ${input.reason}`;
    } else {
      if (!ticket.bookingId) {
        throw apiError("VALIDATION_FAILED", { message: "This ticket is not linked to a reservation." });
      }
      if (input.action === "cancel_booking") {
        const result = await adminCancelBooking({
          bookingId: ticket.bookingId,
          reason: input.reason,
          refundPercent: input.refundPercent,
          adminId: admin.userId,
        });
        note = `Reservation cancelled, ${result.refundUsd} USD refunded — ${input.reason}`;
      } else {
        await refundBooking({
          bookingId: ticket.bookingId,
          amountUsd: input.amountUsd,
          reason: input.reason,
          adminId: admin.userId,
        });
        note = `Refund of ${input.amountUsd} USD issued — ${input.reason}`;
      }
    }

    await addTicketMessage({
      ticketId,
      authorId: admin.userId,
      authorName: admin.email,
      authorRole: "system",
      body: note,
      internalNote: false,
    });
    await recordModeration({
      adminId: admin.userId,
      action: "ticket_action_taken",
      targetKind: "ticket",
      targetId: ticketId,
      reason: input.reason,
      metadata: { action: input.action },
    });

    return ok(res, await getTicket(ticketId));
  }),
);

// --- notification queue -------------------------------------------------------

adminOperationsRouter.get(
  "/notifications",
  requireCapability("audit.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend({ status: z.enum(["queued", "sent", "failed"]).optional() }),
      req,
    );
    return ok(res, await listNotifications(input));
  }),
);

// --- statistics: comparison and export ---------------------------------------

adminOperationsRouter.get(
  "/stats/compare",
  requireCapability("stats.read"),
  asyncHandler(async (req, res) => {
    const { months } = validateQuery(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), req);
    const reports = await adminReports(months * 2);
    const series = reports.monthly;
    const current = series.slice(-months);
    const previous = series.slice(-months * 2, -months);
    const sum = (rows: typeof series, key: "bookings" | "revenueUsd" | "commissionUsd") =>
      rows.reduce((total, row) => total + row[key], 0);
    const delta = (now: number, before: number) => (before === 0 ? (now > 0 ? 100 : 0) : ((now - before) / before) * 100);

    return ok(res, {
      months,
      current: {
        bookings: sum(current, "bookings"),
        revenueUsd: sum(current, "revenueUsd"),
        commissionUsd: sum(current, "commissionUsd"),
      },
      previous: {
        bookings: sum(previous, "bookings"),
        revenueUsd: sum(previous, "revenueUsd"),
        commissionUsd: sum(previous, "commissionUsd"),
      },
      change: {
        bookings: delta(sum(current, "bookings"), sum(previous, "bookings")),
        revenueUsd: delta(sum(current, "revenueUsd"), sum(previous, "revenueUsd")),
        commissionUsd: delta(sum(current, "commissionUsd"), sum(previous, "commissionUsd")),
      },
      series,
    });
  }),
);

/** Occupancy, average basket, signup curve, top destinations, seasonality. */
adminOperationsRouter.get(
  "/stats/insights",
  requireCapability("stats.read"),
  asyncHandler(async (req, res) => {
    const { months } = validateQuery(z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }), req);
    return ok(res, await adminInsights(months));
  }),
);

adminOperationsRouter.get(
  "/stats/export.csv",
  requireCapability("stats.read"),
  asyncHandler(async (req, res) => {
    const { months } = validateQuery(z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }), req);
    const [reports, insights] = await Promise.all([adminReports(months), adminInsights(months)]);
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [
      "section,label,bookings,revenue_usd,commission_usd,nights,extra",
      ...reports.monthly.map(
        (row) => `monthly,${row.month},${row.bookings},${row.revenueUsd},${row.commissionUsd},,`,
      ),
      ...reports.topListings.map((row) => `listing,${cell(row.name)},${row.bookings},${row.revenueUsd},,,`),
      ...reports.topHosts.map((row) => `host,${cell(row.hostName)},${row.listings},${row.revenueUsd},,,`),
      ...reports.cancellations.map((row) => `cancellation,${cell(row.reason)},${row.count},${row.refundedUsd},,,`),
      `summary,occupancy_rate_percent,,,,${insights.occupancy.nightsBooked},${insights.occupancy.rate}`,
      `summary,average_basket_usd,${insights.basketBookings},${insights.averageBasketUsd},,,`,
      ...insights.monthlyOccupancy.map(
        (row) => `occupancy,${row.month},,,,${row.nightsBooked},${row.rate}`,
      ),
      ...insights.signups.map((row) => `signups,${row.month},${row.total},,,,hosts=${row.hosts} guests=${row.guests}`),
      ...insights.topDestinations.map(
        (row) => `destination,${cell(`${row.city}, ${row.country}`)},${row.bookings},${row.revenueUsd},,${row.nights},`,
      ),
      ...insights.seasonality.map(
        (row) => `seasonality,${row.label},${row.bookings},${row.revenueUsd},,${row.nights},`,
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="roomeasy-statistics-${months}m.csv"`);
    // The byte-order mark makes Excel open the file as UTF-8 without a prompt.
    return res.status(200).send(`\uFEFF${lines.join("\r\n")}`);
  }),
);

/** The same statistics export as a native .xlsx workbook. */
adminOperationsRouter.get(
  "/stats/export.xlsx",
  requireCapability("stats.read"),
  asyncHandler(async (req, res) => {
    const { months } = validateQuery(z.object({ months: z.coerce.number().int().min(1).max(36).default(12) }), req);
    const [reports, insights] = await Promise.all([adminReports(months), adminInsights(months)]);

    await sendXlsx(res, `roomeasy-statistics-${months}m.xlsx`, [
      {
        name: "Monthly",
        columns: [
          { header: "Month", key: "month", width: 14, value: (r: (typeof reports.monthly)[number]) => r.month },
          { header: "Bookings", key: "bookings", width: 12, numFmt: "#,##0", value: (r: (typeof reports.monthly)[number]) => r.bookings },
          { header: "Revenue", key: "revenue", width: 16, numFmt: "#,##0.00", value: (r: (typeof reports.monthly)[number]) => r.revenueUsd },
          { header: "Commission", key: "commission", width: 18, numFmt: "#,##0.00", value: (r: (typeof reports.monthly)[number]) => r.commissionUsd },
        ],
        rows: reports.monthly,
      } as never,
      {
        name: "Top listings",
        columns: [
          { header: "Listing", key: "name", width: 32, value: (r: (typeof reports.topListings)[number]) => r.name },
          { header: "Bookings", key: "bookings", width: 12, numFmt: "#,##0", value: (r: (typeof reports.topListings)[number]) => r.bookings },
          { header: "Revenue", key: "revenue", width: 16, numFmt: "#,##0.00", value: (r: (typeof reports.topListings)[number]) => r.revenueUsd },
        ],
        rows: reports.topListings,
      } as never,
      {
        name: "Top hosts",
        columns: [
          { header: "Host", key: "hostName", width: 28, value: (r: (typeof reports.topHosts)[number]) => r.hostName },
          { header: "Listings", key: "listings", width: 12, numFmt: "#,##0", value: (r: (typeof reports.topHosts)[number]) => r.listings },
          { header: "Revenue", key: "revenue", width: 16, numFmt: "#,##0.00", value: (r: (typeof reports.topHosts)[number]) => r.revenueUsd },
        ],
        rows: reports.topHosts,
      } as never,
      {
        name: "Cancellations",
        columns: [
          { header: "Reason", key: "reason", width: 24, value: (r: (typeof reports.cancellations)[number]) => r.reason },
          { header: "Count", key: "count", width: 12, numFmt: "#,##0", value: (r: (typeof reports.cancellations)[number]) => r.count },
          { header: "Refunded", key: "refunded", width: 16, numFmt: "#,##0.00", value: (r: (typeof reports.cancellations)[number]) => r.refundedUsd },
        ],
        rows: reports.cancellations,
      } as never,
      {
        name: "Occupancy & signups",
        columns: [
          { header: "Month", key: "month", width: 14, value: (r: (typeof insights.monthlyOccupancy)[number]) => r.month },
          { header: "Nights booked", key: "nights", width: 16, numFmt: "#,##0", value: (r: (typeof insights.monthlyOccupancy)[number]) => r.nightsBooked },
          { header: "Occupancy rate (%)", key: "rate", width: 18, numFmt: "0.00", value: (r: (typeof insights.monthlyOccupancy)[number]) => r.rate },
        ],
        rows: insights.monthlyOccupancy,
      } as never,
      {
        name: "Top destinations",
        columns: [
          { header: "Destination", key: "destination", width: 28, value: (r: (typeof insights.topDestinations)[number]) => `${r.city}, ${r.country}` },
          { header: "Bookings", key: "bookings", width: 12, numFmt: "#,##0", value: (r: (typeof insights.topDestinations)[number]) => r.bookings },
          { header: "Revenue", key: "revenue", width: 16, numFmt: "#,##0.00", value: (r: (typeof insights.topDestinations)[number]) => r.revenueUsd },
          { header: "Nights", key: "nights", width: 12, numFmt: "#,##0", value: (r: (typeof insights.topDestinations)[number]) => r.nights },
        ],
        rows: insights.topDestinations,
      } as never,
    ]);
  }),
);

// --- finance: ledger, commission report, accounting export, invoices ---------

const dateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** One row per booking with the payment state, commission and host net. */
adminOperationsRouter.get(
  "/finance/ledger",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      pagination.extend(dateRange.shape).extend({
        hostId: z.string().uuid().optional(),
        paymentStatus: z.enum(["all", "none", "pending", "authorized", "paid", "failed", "refunded"]).default("all"),
      }),
      req,
    );
    return ok(res, await financeLedger(input));
  }),
);

/** Commission owed per host over the chosen period. */
adminOperationsRouter.get(
  "/finance/commission-report",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(dateRange, req);
    return ok(res, await commissionReport(input));
  }),
);

/** Accounting totals grouped by month, quarter or year. */
adminOperationsRouter.get(
  "/finance/accounting",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      dateRange.extend({ period: z.enum(["month", "quarter", "year"]).default("month") }),
      req,
    );
    return ok(res, await accountingExport(input));
  }),
);

/** The same accounting totals as a spreadsheet file. */
adminOperationsRouter.get(
  "/finance/accounting.csv",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      dateRange.extend({ period: z.enum(["month", "quarter", "year"]).default("month") }),
      req,
    );
    const rows = await accountingExport(input);
    const lines = [
      "period,currency,bookings,revenue,commission,host_net,service_fee,taxes,cleaning,refunded,paid",
      ...rows.map((r) =>
        [
          r.period,
          r.currency,
          r.bookings,
          r.revenueUsd,
          r.commissionUsd,
          r.hostNetUsd,
          r.serviceFeeUsd,
          r.taxesUsd,
          r.cleaningUsd,
          r.refundedUsd,
          r.paidUsd,
        ].join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="roomeasy-accounting-${input.period}.csv"`);
    return res.status(200).send(`\uFEFF${lines.join("\r\n")}`);
  }),
);

/** The same accounting totals as a native .xlsx workbook. */
adminOperationsRouter.get(
  "/finance/accounting.xlsx",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      dateRange.extend({ period: z.enum(["month", "quarter", "year"]).default("month") }),
      req,
    );
    const rows = await accountingExport(input);
    type AccRow = (typeof rows)[number];
    await sendXlsx(res, `roomeasy-accounting-${input.period}.xlsx`, [
      {
        name: "Accounting",
        columns: [
          { header: "Period", key: "period", width: 14, value: (r: AccRow) => r.period },
          { header: "Currency", key: "currency", width: 10, value: (r: AccRow) => r.currency },
          { header: "Bookings", key: "bookings", width: 12, numFmt: "#,##0", value: (r: AccRow) => r.bookings },
          { header: "Revenue", key: "revenue", width: 16, numFmt: "#,##0.00", value: (r: AccRow) => r.revenueUsd },
          { header: "Commission", key: "commission", width: 18, numFmt: "#,##0.00", value: (r: AccRow) => r.commissionUsd },
          { header: "Host net", key: "hostNet", width: 16, numFmt: "#,##0.00", value: (r: AccRow) => r.hostNetUsd },
          { header: "Service fee", key: "serviceFee", width: 18, numFmt: "#,##0.00", value: (r: AccRow) => r.serviceFeeUsd },
          { header: "Taxes", key: "taxes", width: 14, numFmt: "#,##0.00", value: (r: AccRow) => r.taxesUsd },
          { header: "Cleaning", key: "cleaning", width: 16, numFmt: "#,##0.00", value: (r: AccRow) => r.cleaningUsd },
          { header: "Refunded", key: "refunded", width: 16, numFmt: "#,##0.00", value: (r: AccRow) => r.refundedUsd },
          { header: "Paid", key: "paid", width: 14, numFmt: "#,##0.00", value: (r: AccRow) => r.paidUsd },
        ],
        rows,
      } as never,
    ]);
  }),
);

/** Everything needed to print the invoice of one booking. */
adminOperationsRouter.get(
  "/finance/invoice/:bookingId",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(z.object({ bookingId: z.string().trim().min(3).max(140) }), req);
    const invoice = await bookingInvoice(bookingId);
    if (!invoice) throw apiError("NOT_FOUND", { message: "That reservation does not exist." });
    return ok(res, invoice);
  }),
);

/** The same invoice, rendered as a downloadable PDF. */
adminOperationsRouter.get(
  "/finance/invoice/:bookingId/pdf",
  requireCapability("finance.read"),
  asyncHandler(async (req, res) => {
    const { bookingId } = validateParams(z.object({ bookingId: z.string().trim().min(3).max(140) }), req);
    const invoice = await bookingInvoice(bookingId);
    if (!invoice) throw apiError("NOT_FOUND", { message: "That reservation does not exist." });
    renderInvoicePdf(invoice, res);
  }),
);

/* -------------------------------------------------------------------------- */
/* Email delivery: SMTP health, manual drain, retry and a test message.       */
/* -------------------------------------------------------------------------- */

adminOperationsRouter.get(
  "/email/status",
  requireCapability("settings.manage"),
  asyncHandler(async (_req, res) => {
    const mail = mailerStatus();
    const counts = await notificationCounts();
    return ok(res, {
      smtp: {
        configured: mail.configured,
        dryRun: mail.dryRun,
        host: mail.host,
        port: mail.port,
        secure: mail.secure,
        from: mail.from,
        missing: mail.missing,
      },
      payments: stripeStatus(),
      queue: counts,
    });
  }),
);

adminOperationsRouter.post(
  "/email/verify",
  requireCapability("settings.manage"),
  asyncHandler(async (_req, res) => ok(res, await verifyMailer())),
);

adminOperationsRouter.post(
  "/email/dispatch",
  requireCapability("settings.manage"),
  asyncHandler(async (_req, res) => ok(res, await dispatchQueuedEmails())),
);

adminOperationsRouter.post(
  "/email/test",
  requireCapability("settings.manage"),
  asyncHandler(async (req, res) => {
    const { to } = validateBody(z.object({ to: z.string().trim().email() }), req);
    const admin = currentUser(req);
    await queueNotification({
      recipientEmail: to,
      template: "support_reply",
      subject: "Test message from the back office",
      body: `This is a test email sent from the administration space by ${admin.email}.\n\nIf you can read this, outgoing email works.`,
    });
    const result = await dispatchQueuedEmails(5);
    return created(res, { queued: true, ...result });
  }),
);

adminOperationsRouter.post(
  "/notifications/:id/retry",
  requireCapability("settings.manage"),
  asyncHandler(async (req, res) => {
    const { id } = validateParams(z.object({ id: z.string().uuid() }), req);
    const requeued = await requeueNotification(id);
    if (!requeued) throw apiError("NOT_FOUND", { message: "That email is not in the queue." });
    const result = await dispatchQueuedEmails(5);
    return ok(res, { retried: true, ...result });
  }),
);
