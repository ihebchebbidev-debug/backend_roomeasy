import { Router } from "express";
import { z } from "zod";

import { asyncHandler, created, ok } from "@/core/http.js";
import { queryBoolean, validateBody, validateParams, validateQuery } from "@/core/validate.js";
import { currentUser, isAdmin, requireAuth } from "@/middleware/auth.js";
import {
  getThread,
  listThreads,
  markThreadRead,
  sendMessage,
  setThreadClosed,
  startConversation,
  unreadCount,
} from "@/modules/messaging/messaging.repository.js";

export const messagingRouter = Router();

messagingRouter.use(requireAuth);

const threadParams = z.object({ threadId: z.string().trim().min(1).max(140) });

const bodySchema = z.object({
  body: z.string().trim().min(1, "Write something before sending.").max(4000, "Keep a message under 4000 characters."),
});

/** Inbox: every conversation the caller belongs to. */
messagingRouter.get(
  "/threads",
  asyncHandler(async (req, res) => {
    const input = validateQuery(
      z.object({
        search: z.string().trim().max(120).optional(),
        includeClosed: queryBoolean(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req,
    );
    const result = await listThreads(currentUser(req).userId, input);
    return ok(res, result.items, { total: result.total, unread: result.unread });
  }),
);

/** Badge counter for the header. */
messagingRouter.get(
  "/unread",
  asyncHandler(async (req, res) => ok(res, { unread: await unreadCount(currentUser(req).userId) })),
);

/** One conversation with its messages; opening it clears the unread counter. */
messagingRouter.get(
  "/threads/:threadId",
  asyncHandler(async (req, res) => {
    const { threadId } = validateParams(threadParams, req);
    const { markRead } = validateQuery(z.object({ markRead: queryBoolean(true) }), req);
    const thread = await getThread(threadId, currentUser(req).userId, { isAdmin: isAdmin(req), markRead });
    return ok(res, thread);
  }),
);

/** Start (or reuse) the conversation about a listing and post the first message. */
messagingRouter.post(
  "/threads",
  asyncHandler(async (req, res) => {
    const input = validateBody(
      z.object({
        propertyId: z.string().trim().min(1).max(120),
        bookingId: z.string().trim().max(140).optional(),
        body: bodySchema.shape.body,
      }),
      req,
    );
    const user = currentUser(req);
    const thread = await startConversation({
      propertyId: input.propertyId,
      guestId: user.userId,
      bookingId: input.bookingId ?? null,
      body: input.body,
    });
    req.log.info({ threadId: thread.id, propertyId: input.propertyId }, "conversation started");
    return created(res, thread);
  }),
);

messagingRouter.post(
  "/threads/:threadId/messages",
  asyncHandler(async (req, res) => {
    const { threadId } = validateParams(threadParams, req);
    const { body } = validateBody(bodySchema, req);
    const user = currentUser(req);
    const message = await sendMessage({ threadId, senderId: user.userId, body, isAdmin: isAdmin(req) });
    req.log.info({ threadId, messageId: message.id }, "message sent");
    return created(res, message);
  }),
);

messagingRouter.post(
  "/threads/:threadId/read",
  asyncHandler(async (req, res) => {
    const { threadId } = validateParams(threadParams, req);
    const user = currentUser(req);
    await getThread(threadId, user.userId, { isAdmin: isAdmin(req), markRead: false });
    const touched = await markThreadRead(threadId, user.userId);
    return ok(res, { threadId, markedRead: touched });
  }),
);

messagingRouter.patch(
  "/threads/:threadId",
  asyncHandler(async (req, res) => {
    const { threadId } = validateParams(threadParams, req);
    const { closed } = validateBody(z.object({ closed: z.boolean() }), req);
    const thread = await setThreadClosed({
      threadId,
      viewerId: currentUser(req).userId,
      closed,
      isAdmin: isAdmin(req),
    });
    return ok(res, thread);
  }),
);
