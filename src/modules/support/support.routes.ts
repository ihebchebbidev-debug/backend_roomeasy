import { Router } from "express";
import { z } from "zod";

import { asyncHandler, created, ok } from "@/core/http.js";
import { validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser, requireAuth } from "@/middleware/auth.js";
import { apiError } from "@/core/errors.js";
import { createListingReport } from "@/modules/admin/reports.repository.js";
import { addTicketMessage, createTicket, getTicket, listTickets } from "@/modules/admin/support.repository.js";

/** Member-facing side of the support desk: open a request, reply, report a listing. */
export const supportRouter = Router();

supportRouter.use(requireAuth);

supportRouter.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).default(0),
        status: z.enum(["open", "pending", "resolved", "closed", "all"]).default("all"),
      }),
      req,
    );
    const me = currentUser(req);
    const result = await listTickets({ ...input, openedBy: me.userId });
    return ok(res, result.items, { total: result.total });
  }),
);

supportRouter.post(
  "/tickets",
  asyncHandler(async (req, res) => {
    const input = validateBody(
      z.object({
        subject: z.string().trim().min(3, "Give your request a short title.").max(200),
        category: z.enum(["booking", "payment", "listing", "account", "dispute", "other"]).default("other"),
        bookingId: z.string().trim().max(140).optional(),
        listingId: z.string().trim().max(140).optional(),
        body: z.string().trim().min(10, "Describe the problem in at least 10 characters.").max(4000),
      }),
      req,
    );
    const me = currentUser(req);
    const ticket = await createTicket({
      ...input,
      openedBy: me.userId,
      openedByName: me.email,
      openedByRole: me.roles.includes("host") ? "host" : "guest",
    });
    return created(res, ticket);
  }),
);

supportRouter.get(
  "/tickets/:ticketId",
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(z.object({ ticketId: z.string().uuid() }), req);
    const me = currentUser(req);
    const ticket = await getTicket(ticketId);
    if (ticket.openedById !== me.userId) throw apiError("FORBIDDEN", { message: "This request is not yours." });
    return ok(res, { ...ticket, messages: ticket.messages.filter((message) => !message.internalNote) });
  }),
);

supportRouter.post(
  "/tickets/:ticketId/messages",
  asyncHandler(async (req, res) => {
    const { ticketId } = validateParams(z.object({ ticketId: z.string().uuid() }), req);
    const { body } = validateBody(z.object({ body: z.string().trim().min(1).max(4000) }), req);
    const me = currentUser(req);
    const ticket = await getTicket(ticketId);
    if (ticket.openedById !== me.userId) throw apiError("FORBIDDEN", { message: "This request is not yours." });
    await addTicketMessage({
      ticketId,
      authorId: me.userId,
      authorName: me.email,
      authorRole: me.roles.includes("host") ? "host" : "guest",
      body,
    });
    const updated = await getTicket(ticketId);
    return created(res, { ...updated, messages: updated.messages.filter((message) => !message.internalNote) });
  }),
);

/** Flag a listing; the report lands in the moderation queue. */
supportRouter.post(
  "/reports",
  asyncHandler(async (req, res) => {
    const input = validateBody(
      z.object({
        listingId: z.string().trim().min(1).max(140),
        reason: z.enum(["fraud", "inappropriate", "wrong_information", "unavailable", "safety", "other"]),
        details: z.string().trim().max(2000).optional(),
      }),
      req,
    );
    const me = currentUser(req);
    const report = await createListingReport({
      listingId: input.listingId,
      reportedBy: me.userId,
      reporterName: me.email,
      reason: input.reason,
      details: input.details,
    });
    return created(res, report);
  }),
);
