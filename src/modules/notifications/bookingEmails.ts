import { log } from "@/core/logger.js";
import { queryOne } from "@/db/query.js";
import { queueNotification } from "@/modules/admin/notifications.repository.js";
import { bookingLink, renderTemplate, type TemplateKey } from "@/modules/notifications/templates.js";

const logger = log("booking-emails");

type BookingFacts = {
  id: string;
  reference: string;
  check_in: string;
  check_out: string;
  total_usd: string;
  guest_id: string | null;
  guest_email: string | null;
  guest_name: string;
  stay_name: string;
  host_id: string | null;
  host_name: string | null;
  refund_usd: string | null;
};

async function loadFacts(bookingId: string): Promise<BookingFacts | null> {
  return queryOne<BookingFacts>(
    `SELECT b.id, b.reference, b.check_in::text, b.check_out::text, b.total_usd::text,
            b.guest_id, b.guest_email, b.guest_name, p.name AS stay_name, p.host_id,
            h.full_name AS host_name, c.refund_usd::text AS refund_usd
       FROM booking b
       JOIN property p ON p.id = b.property_id
       LEFT JOIN app_user h ON h.id = p.host_id
       LEFT JOIN booking_cancellation c ON c.booking_id = b.id
      WHERE b.id = $1`,
    [bookingId],
    { label: "bookingEmails.facts" },
  );
}

async function localeOf(userId: string | null): Promise<string> {
  if (!userId) return "en";
  const row = await queryOne<{ locale: string }>("SELECT locale FROM app_user WHERE id = $1", [userId]);
  return row?.locale ?? "en";
}

async function send(template: TemplateKey, to: "guest" | "host", facts: BookingFacts, extra: Record<string, string> = {}) {
  const recipientId = to === "guest" ? facts.guest_id : facts.host_id;
  const recipientEmail = to === "guest" ? facts.guest_email : null;
  if (!recipientId && !recipientEmail) return;
  const copy = renderTemplate(template, await localeOf(recipientId), {
    reference: facts.reference,
    stayName: facts.stay_name,
    checkIn: facts.check_in,
    checkOut: facts.check_out,
    total: `${Math.round(Number(facts.total_usd))} €`,
    guestName: facts.guest_name,
    hostName: facts.host_name ?? "",
    refundUsd: facts.refund_usd ?? "0",
    link: bookingLink(facts.id),
    ...extra,
  });
  await queueNotification({
    recipientId,
    recipientEmail,
    template,
    subject: copy.subject,
    body: copy.body,
    payload: { bookingId: facts.id },
  });
}

/** Queues booking lifecycle emails. Never throws — an email must not break a booking. */
export async function notifyBookingEvent(
  bookingId: string,
  event: "created" | "confirmed" | "declined" | "cancelled_by_guest" | "cancelled_by_host" | "cancelled_by_system",
): Promise<void> {
  try {
    const facts = await loadFacts(bookingId);
    if (!facts) return;
    switch (event) {
      case "created":
        await send("booking_requested_guest", "guest", facts);
        await send("booking_requested_host", "host", facts);
        break;
      case "confirmed":
        await send("booking_confirmed_guest", "guest", facts);
        await send("booking_confirmed_host", "host", facts);
        break;
      case "declined":
        await send("booking_declined_guest", "guest", facts);
        break;
      case "cancelled_by_guest":
        await send("booking_cancelled_by_guest", "host", facts);
        break;
      case "cancelled_by_host":
        await send("booking_cancelled_by_host", "guest", facts);
        break;
      case "cancelled_by_system":
        await send("booking_cancelled_by_system", "guest", facts);
        break;
    }
  } catch (error) {
    logger.warn({ err: error, bookingId, event }, "booking email could not be queued");
  }
}

/** Queues a "new message" email to the other participant of a conversation. */
export async function notifyNewMessage(input: {
  recipientId: string | null;
  senderName: string;
  stayName: string;
  body: string;
  threadId: string;
}): Promise<void> {
  if (!input.recipientId) return;
  try {
    const base = process.env["PUBLIC_APP_URL"] || process.env["APP_URL"] || "https://roomeasy.fr";
    const excerpt = input.body.length > 200 ? `${input.body.slice(0, 197)}...` : input.body;
    const copy = renderTemplate("new_message", await localeOf(input.recipientId), {
      senderName: input.senderName,
      stayName: input.stayName,
      excerpt,
      link: `${base.replace(/\/+$/, "")}/messages?thread=${input.threadId}`,
    });
    await queueNotification({
      recipientId: input.recipientId,
      template: "new_message",
      subject: copy.subject,
      body: copy.body,
      payload: { threadId: input.threadId },
    });
  } catch (error) {
    logger.warn({ err: error, threadId: input.threadId }, "message email could not be queued");
  }
}
