import { query, queryOne } from "@/db/query.js";

export type NotificationTemplate =
  | "listing_approved"
  | "listing_rejected"
  | "listing_suspended"
  | "account_suspended"
  | "account_restored"
  | "account_banned"
  | "identity_verified"
  | "identity_rejected"
  | "booking_cancelled_by_admin"
  | "booking_refunded"
  | "commission_updated"
  | "support_reply"
  | "payouts_ready"
  | "booking_confirmed"
  | "payment_failed"
  | "password_reset";

/**
 * Every administrator decision that affects a member is queued here as an
 * email. A mail provider (or a cron worker) picks the queue up later; the
 * back office never blocks on delivery.
 */
export async function queueNotification(entry: {
  recipientId?: string | null;
  recipientEmail?: string | null;
  template: NotificationTemplate;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  let email = entry.recipientEmail ?? null;
  let locale = "en";

  if (entry.recipientId) {
    const row = await queryOne<{ email: string; locale: string }>(
      "SELECT email, locale FROM app_user WHERE id = $1",
      [entry.recipientId],
      { label: "notifications.recipient" },
    );
    if (row) {
      email = email ?? row.email;
      locale = row.locale;
    }
  }

  if (!email) return; // nothing to send to

  await query(
    `INSERT INTO notification_outbox (recipient_id, recipient_email, template, locale, subject, body, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      entry.recipientId ?? null,
      email,
      entry.template,
      locale,
      entry.subject,
      entry.body,
      JSON.stringify(entry.payload ?? {}),
    ],
    { label: "notifications.queue" },
  );
}

export async function listNotifications(options: { limit: number; offset: number; status?: string }) {
  const rows = await query<{
    id: string;
    recipient_email: string;
    template: string;
    subject: string;
    status: string;
    sent_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, recipient_email, template, subject, status, sent_at, created_at
       FROM notification_outbox
      WHERE ($3::text IS NULL OR status = $3::notification_status)
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [options.limit, options.offset, options.status ?? null],
    { label: "notifications.list" },
  );

  return rows.map((row) => ({
    id: row.id,
    recipientEmail: row.recipient_email,
    template: row.template,
    subject: row.subject,
    status: row.status,
    sentAt: row.sent_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Queue health for the back office: how many rows sit in each state. */
export async function notificationCounts(): Promise<{ queued: number; sending: number; sent: number; failed: number }> {
  const rows = await query<{ status: string; count: string }>(
    "SELECT status::text AS status, count(*)::text AS count FROM notification_outbox GROUP BY status",
    [],
    { label: "notifications.counts" },
  );
  const totals = { queued: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in totals) totals[row.status as keyof typeof totals] = Number(row.count);
  }
  return totals;
}
