import nodemailer, { type Transporter } from "nodemailer";

import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";

const logger = log("mailer");

/**
 * Mailbox credentials are pinned here on purpose (no .env involved).
 * OVH: ssl0.ovh.net, 465 implicit SSL (use 587 + secure:false for STARTTLS).
 */
const SMTP = {
  host: "ssl0.ovh.net",
  port: 465,
  secure: true, // false when port is 587 (STARTTLS)
  user: "remquip_email_confirmationaccoun@luccibyey.com.tn",
  password: "Dadouhibou2025",
  from: "remquip_email_confirmationaccoun@luccibyey.com.tn",
} as const;

/**
 * SMTP delivery, written for OVH but valid for any provider.
 *
 * OVH defaults (Exchange / MX Plan / Email Pro):
 *   host   ssl0.ovh.net
 *   port   465 with implicit TLS (SMTP_SECURE=true)  — or 587 with STARTTLS
 *   user   the full mailbox address, e.g. no-reply@yourdomain.com
 *
 * Nothing here throws when the credentials are missing: the app keeps working
 * and every message stays queued until the mailbox details are filled in.
 */

export type MailerStatus = {
  configured: boolean;
  dryRun: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string;
  missing: string[];
};

function missingSettings(): string[] {
  const missing: string[] = [];
  if (!SMTP.host) missing.push("SMTP_HOST");
  if (!SMTP.user) missing.push("SMTP_USER");
  if (!SMTP.password) missing.push("SMTP_PASSWORD");
  if (!fromAddress()) missing.push("MAIL_FROM_ADDRESS");
  return missing;
}

function fromAddress(): string {
  return (SMTP.from || SMTP.user).trim();
}

export function mailFrom(): string {
  const address = fromAddress();
  const name = env.MAIL_FROM_NAME.trim();
  if (!address) return "";
  return name ? `"${name.replace(/"/g, "")}" <${address}>` : address;
}

export function mailerStatus(): MailerStatus {
  const missing = missingSettings();
  return {
    configured: missing.length === 0,
    dryRun: env.MAIL_DRY_RUN,
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    user: SMTP.user,
    from: mailFrom(),
    missing,
  };
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (missingSettings().length > 0) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    // 465 = implicit TLS, 587 = STARTTLS upgrade.
    secure: SMTP.secure,
    auth: { user: SMTP.user, pass: SMTP.password },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  logger.info({ host: SMTP.host, port: SMTP.port, secure: SMTP.secure }, "smtp transport ready");
  return transporter;
}

/** Confirms the credentials against the SMTP server. Used by the back office. */
export async function verifyMailer(): Promise<{ ok: boolean; error?: string }> {
  const transport = getTransporter();
  if (!transport) return { ok: false, error: `Missing settings: ${missingSettings().join(", ")}` };
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
};

/**
 * Sends one message. Returns the provider message id, or throws so the caller
 * can mark the queue row as failed and retry later.
 */
export async function sendMail(mail: OutgoingMail): Promise<{ messageId: string; dryRun: boolean }> {
  if (env.MAIL_DRY_RUN) {
    logger.info({ to: mail.to, subject: mail.subject }, "mail dry run — not sent");
    return { messageId: `dry-run-${Date.now()}`, dryRun: true };
  }

  const transport = getTransporter();
  if (!transport) throw new Error(`SMTP is not configured (missing: ${missingSettings().join(", ")})`);

  const info = await transport.sendMail({
    from: mailFrom(),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html ?? undefined,
    replyTo: mail.replyTo ?? env.MAIL_REPLY_TO ?? undefined,
    envelope: { from: fromAddress(), to: mail.to },
  });

  return { messageId: info.messageId, dryRun: false };
}

export function resetMailer(): void {
  transporter?.close();
  transporter = null;
}
