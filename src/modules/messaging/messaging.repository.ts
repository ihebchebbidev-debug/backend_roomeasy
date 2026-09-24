import { notifyNewMessage } from "@/modules/notifications/bookingEmails.js";
import { apiError } from "@/core/errors.js";
import { threadId as buildThreadId } from "@/core/ids.js";
import { query, queryOne, transaction } from "@/db/query.js";

/**
 * Conversations between a guest and a host, always anchored to a listing and
 * optionally to a booking. The shape mirrors the inbox screen
 * (`src/routes/messages.tsx`): a thread carries the other person's name, an
 * unread counter and the ordered messages.
 */

export type MessageDto = {
  id: string;
  from: "me" | "them";
  senderRole: "guest" | "host" | "admin" | "system";
  text: string;
  sentAt: string;
  time: string;
  readAt: string | null;
};

export type ThreadSummaryDto = {
  id: string;
  propertyId: string | null;
  bookingId: string | null;
  withName: string;
  withAvatar: string | null;
  closed: boolean;
  unread: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
};

export type ThreadDto = ThreadSummaryDto & { messages: MessageDto[] };

type ThreadRow = {
  id: string;
  property_id: string | null;
  booking_id: string | null;
  guest_id: string | null;
  host_id: string | null;
  with_name: string;
  closed: boolean;
  last_message_at: Date | null;
  guest_name: string | null;
  host_name: string | null;
  guest_avatar: string | null;
  host_avatar: string | null;
  unread: string | null;
  last_body: string | null;
};

type MessageRow = {
  id: string;
  sender_id: string | null;
  sender_role: "guest" | "host" | "admin" | "system";
  body: string;
  sent_at: Date;
  read_at: Date | null;
};

function clockOf(value: Date): string {
  return value.toISOString().slice(11, 16);
}

function counterpartName(row: ThreadRow, viewerId: string): string {
  if (row.host_id === viewerId) return row.guest_name ?? row.with_name ?? "Guest";
  if (row.guest_id === viewerId) return row.host_name ?? row.with_name ?? "Host";
  return row.with_name || row.guest_name || row.host_name || "Conversation";
}

function counterpartAvatar(row: ThreadRow, viewerId: string): string | null {
  if (row.host_id === viewerId) return row.guest_avatar;
  if (row.guest_id === viewerId) return row.host_avatar;
  return null;
}

function mapThread(row: ThreadRow, viewerId: string): ThreadSummaryDto {
  return {
    id: row.id,
    propertyId: row.property_id,
    bookingId: row.booking_id,
    withName: counterpartName(row, viewerId),
    withAvatar: counterpartAvatar(row, viewerId),
    closed: row.closed,
    unread: Number(row.unread ?? 0),
    lastMessage: row.last_body,
    lastMessageAt: row.last_message_at ? row.last_message_at.toISOString() : null,
  };
}

function mapMessage(row: MessageRow, viewerId: string): MessageDto {
  return {
    id: row.id,
    from: row.sender_id && row.sender_id === viewerId ? "me" : "them",
    senderRole: row.sender_role,
    text: row.body,
    sentAt: row.sent_at.toISOString(),
    time: clockOf(row.sent_at),
    readAt: row.read_at ? row.read_at.toISOString() : null,
  };
}

const THREAD_SELECT = `
  SELECT t.id, t.property_id, t.booking_id, t.guest_id, t.host_id, t.with_name, t.closed, t.last_message_at,
         gu.full_name AS guest_name,
         gu.avatar_url AS guest_avatar,
         coalesce(hp.display_name, hu.full_name) AS host_name,
         hu.avatar_url AS host_avatar,
         (SELECT count(*) FROM message m
           WHERE m.thread_id = t.id AND m.read_at IS NULL AND (m.sender_id IS NULL OR m.sender_id <> $1)) AS unread,
         (SELECT m.body FROM message m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS last_body
    FROM message_thread t
    LEFT JOIN app_user gu ON gu.id = t.guest_id
    LEFT JOIN app_user hu ON hu.id = t.host_id
    LEFT JOIN host_profile hp ON hp.user_id = t.host_id`;

/** Every conversation the signed-in person takes part in, newest first. */
export async function listThreads(
  viewerId: string,
  options: { search?: string; includeClosed?: boolean; limit?: number; offset?: number } = {},
): Promise<{ items: ThreadSummaryDto[]; total: number; unread: number }> {
  const values: unknown[] = [viewerId];
  const where: string[] = ["(t.guest_id = $1 OR t.host_id = $1)"];

  if (!options.includeClosed) where.push("t.closed = false");

  if (options.search?.trim()) {
    values.push(`%${options.search.trim()}%`);
    where.push(
      `(t.with_name ILIKE $${values.length} OR gu.full_name ILIKE $${values.length}
        OR hu.full_name ILIKE $${values.length} OR t.property_id ILIKE $${values.length})`,
    );
  }

  values.push(options.limit ?? 50, options.offset ?? 0);

  const rows = await query<ThreadRow>(
    `${THREAD_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY coalesce(t.last_message_at, t.created_at) DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    { label: "messaging.listThreads" },
  );

  const totals = await queryOne<{ total: string; unread: string }>(
    `SELECT count(DISTINCT t.id) AS total,
            coalesce(sum((SELECT count(*) FROM message m
                           WHERE m.thread_id = t.id AND m.read_at IS NULL
                             AND (m.sender_id IS NULL OR m.sender_id <> $1))), 0) AS unread
       FROM message_thread t
      WHERE t.guest_id = $1 OR t.host_id = $1`,
    [viewerId],
    { label: "messaging.threadTotals" },
  );

  return {
    items: rows.map((row) => mapThread(row, viewerId)),
    total: Number(totals?.total ?? 0),
    unread: Number(totals?.unread ?? 0),
  };
}

async function loadThreadRow(threadId: string, viewerId: string, isAdmin: boolean): Promise<ThreadRow> {
  const row = await queryOne<ThreadRow>(`${THREAD_SELECT} WHERE t.id = $2`, [viewerId, threadId], {
    label: "messaging.loadThread",
  });

  if (!row) {
    throw apiError("NOT_FOUND", { message: "That conversation does not exist.", details: { threadId } });
  }
  if (!isAdmin && row.guest_id !== viewerId && row.host_id !== viewerId) {
    throw apiError("NOT_THREAD_PARTICIPANT", { details: { threadId } });
  }
  return row;
}

/** One conversation with its messages. Reading it clears the unread counter. */
export async function getThread(
  threadId: string,
  viewerId: string,
  options: { isAdmin?: boolean; markRead?: boolean } = {},
): Promise<ThreadDto> {
  const row = await loadThreadRow(threadId, viewerId, options.isAdmin === true);

  if (options.markRead !== false) await markThreadRead(threadId, viewerId);

  const messages = await query<MessageRow>(
    `SELECT id::text, sender_id, sender_role, body, sent_at, read_at
       FROM message WHERE thread_id = $1 ORDER BY sent_at, id`,
    [threadId],
    { label: "messaging.listMessages" },
  );

  return {
    ...mapThread(row, viewerId),
    unread: options.markRead === false ? Number(row.unread ?? 0) : 0,
    messages: messages.map((message) => mapMessage(message, viewerId)),
  };
}

/** Marks everything the other side wrote as read. Returns the number touched. */
export async function markThreadRead(threadId: string, viewerId: string): Promise<number> {
  const rows = await query(
    `UPDATE message SET read_at = now()
      WHERE thread_id = $1 AND read_at IS NULL AND (sender_id IS NULL OR sender_id <> $2)
      RETURNING id`,
    [threadId, viewerId],
    { label: "messaging.markRead" },
  );
  return rows.length;
}

/**
 * Finds the conversation for a listing (and optionally a booking), creating it
 * on first contact. Guests start threads from a stay page; hosts reply.
 */
export async function ensureThread(input: {
  propertyId: string;
  guestId: string;
  bookingId?: string | null;
}): Promise<ThreadRow> {
  const property = await queryOne<{ host_id: string | null; name: string }>(
    `SELECT host_id, name FROM property WHERE id = $1`,
    [input.propertyId],
    { label: "messaging.propertyForThread" },
  );

  if (!property) {
    throw apiError("NOT_FOUND", { message: "That stay does not exist.", details: { propertyId: input.propertyId } });
  }
  if (property.host_id && property.host_id === input.guestId) {
    throw apiError("CONFLICT", { message: "You cannot start a conversation with yourself about your own listing." });
  }

  const existing = await queryOne<ThreadRow>(
    `${THREAD_SELECT} WHERE t.property_id = $2 AND t.guest_id = $1`,
    [input.guestId, input.propertyId],
    { label: "messaging.findThread" },
  );
  if (existing) {
    if (input.bookingId && !existing.booking_id) {
      await query(`UPDATE message_thread SET booking_id = $2, updated_at = now() WHERE id = $1`, [
        existing.id,
        input.bookingId,
      ], { label: "messaging.attachBooking" });
      existing.booking_id = input.bookingId;
    }
    return existing;
  }

  const id = `${buildThreadId(input.propertyId)}-${input.guestId.slice(0, 8)}`.slice(0, 120);
  const guest = await queryOne<{ full_name: string }>(`SELECT full_name FROM app_user WHERE id = $1`, [input.guestId], {
    label: "messaging.guestName",
  });

  await query(
    `INSERT INTO message_thread (id, property_id, booking_id, guest_id, host_id, with_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [id, input.propertyId, input.bookingId ?? null, input.guestId, property.host_id, guest?.full_name ?? "Guest"],
    { label: "messaging.createThread" },
  );

  return loadThreadRow(id, input.guestId, false);
}

/** Posts a message. The sender must be a participant and the thread must be open. */
export async function sendMessage(input: {
  threadId: string;
  senderId: string;
  body: string;
  isAdmin?: boolean;
}): Promise<MessageDto> {
  const thread = await loadThreadRow(input.threadId, input.senderId, input.isAdmin === true);

  if (thread.closed) {
    throw apiError("THREAD_CLOSED", {
      message: "This conversation is closed. Reopen it before sending another message.",
      details: { threadId: input.threadId },
    });
  }

  const body = input.body.trim();
  if (!body) {
    throw apiError("VALIDATION_FAILED", {
      message: "Write something before sending.",
      issues: [{ field: "body", message: "The message cannot be empty." }],
    });
  }

  const senderRole =
    thread.host_id === input.senderId ? "host" : thread.guest_id === input.senderId ? "guest" : "admin";

  const message = await transaction(async (client) => {
    const row = await queryOne<MessageRow>(
      `INSERT INTO message (thread_id, sender_id, sender_role, body)
       VALUES ($1, $2, $3::actor_role, $4)
       RETURNING id::text, sender_id, sender_role, body, sent_at, read_at`,
      [input.threadId, input.senderId, senderRole, body],
      { client, label: "messaging.insertMessage" },
    );

    await query(`UPDATE message_thread SET last_message_at = now(), updated_at = now() WHERE id = $1`, [
      input.threadId,
    ], { client, label: "messaging.touchThread" });

    return mapMessage(row!, input.senderId);
  }, "messaging.sendMessage");

  const recipientId = senderRole === "host" ? thread.guest_id : senderRole === "guest" ? thread.host_id : null;
  const senderName = (senderRole === "host" ? thread.host_name : thread.guest_name) ?? "RoomEasy";
  const stay = thread.property_id
    ? await queryOne<{ name: string }>("SELECT name FROM property WHERE id = $1", [thread.property_id])
    : null;
  void notifyNewMessage({ recipientId, senderName, stayName: stay?.name ?? "RoomEasy", body, threadId: input.threadId });
  return message;
}

/** Starts (or reuses) a conversation and posts the first message in one call. */
export async function startConversation(input: {
  propertyId: string;
  guestId: string;
  bookingId?: string | null;
  body: string;
}): Promise<ThreadDto> {
  const thread = await ensureThread(input);
  await sendMessage({ threadId: thread.id, senderId: input.guestId, body: input.body });
  return getThread(thread.id, input.guestId, { markRead: false });
}

/** Closes or reopens a conversation. Either participant (or an admin) may do it. */
export async function setThreadClosed(input: {
  threadId: string;
  viewerId: string;
  closed: boolean;
  isAdmin?: boolean;
}): Promise<ThreadSummaryDto> {
  await loadThreadRow(input.threadId, input.viewerId, input.isAdmin === true);
  await query(`UPDATE message_thread SET closed = $2, updated_at = now() WHERE id = $1`, [
    input.threadId,
    input.closed,
  ], { label: "messaging.setClosed" });

  const row = await loadThreadRow(input.threadId, input.viewerId, input.isAdmin === true);
  return mapThread(row, input.viewerId);
}

/** Total unread messages for the header badge. */
export async function unreadCount(viewerId: string): Promise<number> {
  const row = await queryOne<{ unread: string }>(
    `SELECT count(*) AS unread
       FROM message m
       JOIN message_thread t ON t.id = m.thread_id
      WHERE (t.guest_id = $1 OR t.host_id = $1)
        AND m.read_at IS NULL
        AND (m.sender_id IS NULL OR m.sender_id <> $1)`,
    [viewerId],
    { label: "messaging.unreadCount" },
  );
  return Number(row?.unread ?? 0);
}

/**
 * Read-only view of the traveller-host conversation attached to a booking, for
 * the back office. Falls back to the thread that links the same guest and the
 * same listing when no thread was anchored to the booking itself.
 */
export type BookingConversationDto = {
  threadId: string | null;
  guestName: string | null;
  hostName: string | null;
  messages: { id: string; senderRole: "guest" | "host" | "admin" | "system"; senderName: string | null; text: string; sentAt: string }[];
};

export async function bookingConversation(bookingId: string): Promise<BookingConversationDto> {
  const thread = await queryOne<{
    id: string;
    guest_name: string | null;
    host_name: string | null;
  }>(
    `SELECT t.id, gu.full_name AS guest_name, coalesce(hp.display_name, hu.full_name) AS host_name
       FROM message_thread t
       LEFT JOIN app_user gu ON gu.id = t.guest_id
       LEFT JOIN app_user hu ON hu.id = t.host_id
       LEFT JOIN host_profile hp ON hp.user_id = t.host_id
      WHERE t.booking_id = $1
         OR (t.property_id = (SELECT property_id FROM booking WHERE id = $1)
             AND t.guest_id = (SELECT guest_id FROM booking WHERE id = $1))
      ORDER BY (t.booking_id = $1) DESC, t.last_message_at DESC NULLS LAST
      LIMIT 1`,
    [bookingId],
    { label: "messaging.bookingConversation" },
  );

  if (!thread) return { threadId: null, guestName: null, hostName: null, messages: [] };

  const rows = await query<{
    id: string;
    sender_role: "guest" | "host" | "admin" | "system";
    sender_name: string | null;
    body: string;
    sent_at: Date;
  }>(
    `SELECT m.id::text, m.sender_role, u.full_name AS sender_name, m.body, m.sent_at
       FROM message m
       LEFT JOIN app_user u ON u.id = m.sender_id
      WHERE m.thread_id = $1
      ORDER BY m.sent_at, m.id`,
    [thread.id],
    { label: "messaging.bookingConversationMessages" },
  );

  return {
    threadId: thread.id,
    guestName: thread.guest_name,
    hostName: thread.host_name,
    messages: rows.map((row) => ({
      id: row.id,
      senderRole: row.sender_role,
      senderName: row.sender_name,
      text: row.body,
      sentAt: row.sent_at.toISOString(),
    })),
  };
}
