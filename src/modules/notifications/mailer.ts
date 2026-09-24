import nodemailer, { type Transporter } from "nodemailer";

import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";

const logger = log("mailer");

import { cfg, cfgBool, onIntegrationChange } from "@/modules/settings/integration-config.js";

/** Mailbox settings come from the back office (Réglages), falling back to .env. */
const SMTP = {
  get host() { return cfg("SMTP_HOST").trim(); },
  get port() { return Number(cfg("SMTP_PORT")) || 465; },
  get secure() { return cfgBool("SMTP_SECURE"); },
  get user() { return cfg("SMTP_USER").trim(); },
  get password() { return cfg("SMTP_PASSWORD"); },
  get from() { return cfg("MAIL_FROM_ADDRESS").trim(); },
};

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
  const name = cfg("MAIL_FROM_NAME").trim();
  if (!address) return "";
  return name ? `"${name.replace(/"/g, "")}" <${address}>` : address;
}

export function mailerStatus(): MailerStatus {
  const missing = missingSettings();
  return {
    configured: missing.length === 0,
    dryRun: cfgBool("MAIL_DRY_RUN"),
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
  if (cfgBool("MAIL_DRY_RUN")) {
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
    replyTo: mail.replyTo ?? (cfg("MAIL_REPLY_TO").trim() || undefined),
    envelope: { from: fromAddress(), to: mail.to },
  });

  return { messageId: info.messageId, dryRun: false };
}

export function resetMailer(): void {
  transporter?.close();
  transporter = null;
}

onIntegrationChange(resetMailer);
