import { apiError } from "@/core/errors.js";
import { query, queryOne } from "@/db/query.js";

export type TicketStatus = "open" | "pending" | "awaiting_reply" | "escalated" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketCategory = "booking" | "payment" | "listing" | "account" | "dispute" | "other";

type TicketRow = {
  id: string;
  reference: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  opened_by: string | null;
  opened_by_name: string;
  opened_by_role: string;
  opened_by_email: string | null;
  booking_id: string | null;
  listing_id: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
  resolution: string | null;
  closed_at: Date | null;
  last_activity_at: Date;
  created_at: Date;
  message_count?: string;
};

function mapTicket(row: TicketRow) {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    openedById: row.opened_by,
    openedByName: row.opened_by_name,
    openedByRole: row.opened_by_role,
    openedByEmail: row.opened_by_email,
    bookingId: row.booking_id,
    listingId: row.listing_id,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name,
    resolution: row.resolution,
    closedAt: row.closed_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    messageCount: row.message_count === undefined ? undefined : Number(row.message_count),
  };
}

const selectTicket = `
  SELECT t.id, t.reference, t.subject, t.category, t.priority, t.status,
         t.opened_by, t.opened_by_name, t.opened_by_role, ou.email AS opened_by_email,
         t.booking_id, t.listing_id, t.assigned_to, au.full_name AS assignee_name,
         t.resolution, t.closed_at, t.last_activity_at, t.created_at,
         (SELECT count(*) FROM support_ticket_message m WHERE m.ticket_id = t.id)::text AS message_count
    FROM support_ticket t
    LEFT JOIN app_user ou ON ou.id = t.opened_by
    LEFT JOIN app_user au ON au.id = t.assigned_to`;

export async function createTicket(input: {
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  openedBy: string | null;
  openedByName: string;
  openedByRole: "guest" | "host" | "admin";
  bookingId?: string | null;
  listingId?: string | null;
  body: string;
}) {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO support_ticket
       (reference, subject, category, priority, opened_by, opened_by_name, opened_by_role, booking_id, listing_id)
     VALUES ('TK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
             $1, $2, coalesce($3::ticket_priority, 'normal'), $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.subject,
      input.category,
      input.priority ?? null,
      input.openedBy,
      input.openedByName,
      input.openedByRole,
      input.bookingId ?? null,
      input.listingId ?? null,
    ],
    { label: "support.createTicket" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "The ticket could not be created." });

  await addTicketMessage({
    ticketId: row.id,
    authorId: input.openedBy,
    authorName: input.openedByName,
    authorRole: input.openedByRole,
    body: input.body,
    internalNote: false,
  });

  return getTicket(row.id);
}

export async function getTicket(ticketId: string) {
  const ticket = await queryOne<TicketRow>(`${selectTicket} WHERE t.id = $1`, [ticketId], { label: "support.getTicket" });
  if (!ticket) throw apiError("NOT_FOUND", { message: "That ticket does not exist." });

  const messages = await query<{
    id: string;
    author_id: string | null;
    author_name: string;
    author_role: string;
    body: string;
    internal_note: boolean;
    sent_at: Date;
  }>(
    `SELECT id, author_id, author_name, author_role, body, internal_note, sent_at
       FROM support_ticket_message
      WHERE ticket_id = $1
      ORDER BY sent_at`,
    [ticketId],
    { label: "support.messages" },
  );

  return {
    ...mapTicket(ticket),
    messages: messages.map((message) => ({
      id: message.id,
      authorId: message.author_id,
      authorName: message.author_name,
      authorRole: message.author_role,
      body: message.body,
      internalNote: message.internal_note,
      sentAt: message.sent_at.toISOString(),
    })),
  };
}

export async function listTickets(options: {
  limit: number;
  offset: number;
  status?: TicketStatus | "all";
  category?: TicketCategory;
  assignedTo?: string;
  openedBy?: string;
  search?: string;
}) {
  const status = !options.status || options.status === "all" ? null : options.status;
  const rows = await query<TicketRow>(
    `${selectTicket}
      WHERE ($3::ticket_status IS NULL OR t.status = $3::ticket_status)
        AND ($4::ticket_category IS NULL OR t.category = $4::ticket_category)
        AND ($5::uuid IS NULL OR t.assigned_to = $5::uuid)
        AND ($6::uuid IS NULL OR t.opened_by = $6::uuid)
        AND ($7::text IS NULL OR t.subject ILIKE '%' || $7 || '%' OR t.reference ILIKE '%' || $7 || '%'
             OR t.opened_by_name ILIKE '%' || $7 || '%')
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               t.last_activity_at DESC
      LIMIT $1 OFFSET $2`,
    [
      options.limit,
      options.offset,
      status,
      options.category ?? null,
      options.assignedTo ?? null,
      options.openedBy ?? null,
      options.search ?? null,
    ],
    { label: "support.listTickets" },
  );

  const totals = await queryOne<{ total: string; open: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status IN ('open', 'pending', 'awaiting_reply', 'escalated'))::text AS open
       FROM support_ticket
      WHERE ($1::ticket_status IS NULL OR status = $1::ticket_status)`,
    [status],
    { label: "support.countTickets" },
  );

  return { items: rows.map(mapTicket), total: Number(totals?.total ?? 0), openCount: Number(totals?.open ?? 0) };
}

export async function addTicketMessage(input: {
  ticketId: string;
  authorId: string | null;
  authorName: string;
  authorRole: "guest" | "host" | "admin" | "system";
  body: string;
  internalNote?: boolean;
}) {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO support_ticket_message (ticket_id, author_id, author_name, author_role, body, internal_note)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, false))
     RETURNING id`,
    [input.ticketId, input.authorId, input.authorName, input.authorRole, input.body, input.internalNote ?? false],
    { label: "support.addMessage" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That ticket does not exist." });

  // An answer from the desk puts the ticket in "awaiting reply"; an answer from
  // the guest or host brings it back to the queue, even if it was closed.
  await query(
    `UPDATE support_ticket
        SET last_activity_at = now(),
            status = CASE
                       WHEN $2 THEN status
                       WHEN $3 = 'admin' AND status <> 'escalated' THEN 'awaiting_reply'::ticket_status
                       WHEN $3 IN ('guest', 'host') AND status IN ('resolved', 'closed', 'awaiting_reply')
                         THEN 'open'::ticket_status
                       ELSE status
                     END
      WHERE id = $1`,
    [input.ticketId, input.internalNote ?? false, input.authorRole],
    { label: "support.touchTicket" },
  );
  return row.id;
}

export async function assignTicket(ticketId: string, adminId: string | null) {
  const row = await queryOne<{ id: string }>(
    "UPDATE support_ticket SET assigned_to = $2, last_activity_at = now() WHERE id = $1 RETURNING id",
    [ticketId, adminId],
    { label: "support.assign" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That ticket does not exist." });
  return getTicket(ticketId);
}

export async function setTicketStatus(input: {
  ticketId: string;
  status: TicketStatus;
  resolution?: string | null;
}) {
  const row = await queryOne<{ id: string }>(
    `UPDATE support_ticket
        SET status = $2::ticket_status,
            resolution = coalesce($3, resolution),
            closed_at = CASE WHEN $2::ticket_status IN ('resolved', 'closed') THEN now() ELSE NULL END,
            last_activity_at = now()
      WHERE id = $1
      RETURNING id`,
    [input.ticketId, input.status, input.resolution ?? null],
    { label: "support.setStatus" },
  );
  if (!row) throw apiError("NOT_FOUND", { message: "That ticket does not exist." });
  return getTicket(input.ticketId);
}
