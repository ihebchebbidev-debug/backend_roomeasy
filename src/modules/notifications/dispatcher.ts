import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { query } from "@/db/query.js";
import { mailerStatus, sendMail } from "@/modules/notifications/mailer.js";
import { renderNotificationHtml, renderPasswordResetHtml } from "@/modules/notifications/render.js";

const logger = log("notifications");

type QueueRow = {
  id: string;
  recipient_email: string;
  subject: string;
  body: string;
  locale: string;
  attempts: number;
  template: string;
  payload: Record<string, unknown> | null;
};

/**
 * Drains `notification_outbox`. Every administrator decision queues a row; this
 * worker turns queued rows into SMTP messages, marks them sent, and retries
 * failures with a growing back-off up to MAIL_MAX_ATTEMPTS.
 */
export async function dispatchQueuedEmails(limit = env.MAIL_BATCH_SIZE): Promise<{
  sent: number;
  failed: number;
  skipped: number;
}> {
  const status = mailerStatus();
  if (!status.configured && !status.dryRun) return { sent: 0, failed: 0, skipped: 0 };

  // Claim rows so two workers never send the same message twice.
  const rows = await query<QueueRow>(
    `UPDATE notification_outbox SET status = 'sending', last_attempt_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notification_outbox
         WHERE status = 'queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, recipient_email, subject, body, locale, attempts, template::text AS template, payload`,
    [limit],
    { label: "notifications.claim" },
  );

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const code = typeof row.payload?.["code"] === "string" ? (row.payload["code"] as string) : null;
      const html =
        row.template === "password_reset" && code
          ? renderPasswordResetHtml({
              code,
              name: typeof row.payload?.["name"] === "string" ? (row.payload["name"] as string) : null,
              locale: row.locale,
            })
          : renderNotificationHtml({ subject: row.subject, body: row.body, locale: row.locale });

      const result = await sendMail({
        to: row.recipient_email,
        subject: row.subject,
        text: row.body,
        html,
      });
      await query(
        `UPDATE notification_outbox
            SET status = 'sent', sent_at = now(), error_message = NULL, provider_message_id = $2
          WHERE id = $1`,
        [row.id, result.messageId],
        { label: "notifications.sent" },
      );
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const giveUp = row.attempts >= env.MAIL_MAX_ATTEMPTS;
      // 1 min, 5 min, 25 min, ... so a mailbox outage does not spin the worker.
      const backoffMinutes = Math.min(60 * 6, 5 ** Math.max(0, row.attempts - 1));
      await query(
        `UPDATE notification_outbox
            SET status = $3::notification_status,
                error_message = $2,
                next_attempt_at = CASE WHEN $3 = 'queued' THEN now() + ($4 || ' minutes')::interval ELSE NULL END
          WHERE id = $1`,
        [row.id, message.slice(0, 500), giveUp ? "failed" : "queued", String(backoffMinutes)],
        { label: "notifications.failed" },
      );
      failed += 1;
      logger.warn({ id: row.id, attempts: row.attempts, err: message }, "email delivery failed");
    }
  }

  if (sent || failed) logger.info({ sent, failed }, "notification queue drained");
  return { sent, failed, skipped: 0 };
}

/** Puts a failed or sent row back in the queue so the next run retries it. */
export async function requeueNotification(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE notification_outbox
        SET status = 'queued', attempts = 0, next_attempt_at = NULL, error_message = NULL
      WHERE id = $1 RETURNING id`,
    [id],
    { label: "notifications.requeue" },
  );
  return rows.length > 0;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the background worker; a no-op when MAIL_WORKER is off. */
export function startNotificationWorker(): void {
  if (timer || !env.MAIL_WORKER) return;
  const status = mailerStatus();
  if (!status.configured && !status.dryRun) {
    logger.warn({ missing: status.missing }, "email worker idle — SMTP credentials not set yet");
  }

  const tick = () => {
    void dispatchQueuedEmails().catch((error) => logger.error({ err: error }, "notification worker run failed"));
  };

  timer = setInterval(tick, env.MAIL_POLL_SECONDS * 1000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  logger.info({ everySeconds: env.MAIL_POLL_SECONDS }, "notification worker started");
}

export function stopNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
