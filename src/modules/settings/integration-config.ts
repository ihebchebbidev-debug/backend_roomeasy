import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { query } from "@/db/query.js";

const logger = log("integration-config");

/**
 * Email and Stripe credentials. Values saved from the back office (table
 * integration_setting) win; anything left empty falls back to the .env file.
 * Kept in memory so the mailer and Stripe client can read them synchronously.
 */
export const INTEGRATION_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "MAIL_FROM_ADDRESS",
  "MAIL_FROM_NAME",
  "MAIL_REPLY_TO",
  "MAIL_DRY_RUN",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_COUNTRY",
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/** Never sent back to the browser in clear. */
export const SECRET_KEYS: IntegrationKey[] = ["SMTP_PASSWORD", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

const stored = new Map<IntegrationKey, string>();
const listeners: (() => void)[] = [];

function envValue(key: IntegrationKey): string {
  const raw = (env as Record<string, unknown>)[key];
  if (raw === undefined || raw === null) return "";
  return String(raw);
}

export function cfg(key: IntegrationKey): string {
  const value = stored.get(key);
  return value !== undefined && value !== "" ? value : envValue(key);
}

export function cfgBool(key: IntegrationKey): boolean {
  return ["1", "true", "yes", "on"].includes(cfg(key).trim().toLowerCase());
}

export function cfgSource(key: IntegrationKey): "admin" | "env" | "none" {
  if (stored.get(key)) return "admin";
  return envValue(key) ? "env" : "none";
}

export function onIntegrationChange(listener: () => void): void {
  listeners.push(listener);
}

export async function loadIntegrationConfig(): Promise<void> {
  try {
    const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM integration_setting`, [], {
      label: "integration.load",
    });
    stored.clear();
    for (const row of rows) {
      if ((INTEGRATION_KEYS as readonly string[]).includes(row.key)) stored.set(row.key as IntegrationKey, row.value);
    }
    listeners.forEach((fn) => fn());
  } catch (error) {
    logger.error({ err: error }, "could not load integration settings — using .env only");
  }
}

/** `undefined` keeps the current value, `""` clears the override (back to .env). */
export async function saveIntegrationConfig(
  patch: Partial<Record<IntegrationKey, string>>,
  adminId: string,
): Promise<void> {
  for (const [key, value] of Object.entries(patch) as [IntegrationKey, string | undefined][]) {
    if (value === undefined) continue;
    if (value === "") {
      await query(`DELETE FROM integration_setting WHERE key = $1`, [key], { label: "integration.clear" });
    } else {
      await query(
        `INSERT INTO integration_setting (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, value, adminId],
        { label: "integration.save" },
      );
    }
  }
  await loadIntegrationConfig();
}

function mask(value: string): string {
  if (!value) return "";
  return `••••${value.slice(-4)}`;
}

/** Back office view (admin only): real values, exactly as stored or in .env. */
export function integrationView() {
  return Object.fromEntries(
    INTEGRATION_KEYS.map((key) => {
      const value = cfg(key);
      const secret = SECRET_KEYS.includes(key);
      return [key, { value, masked: secret ? mask(value) : null, set: value !== "", secret, source: cfgSource(key) }];
    }),
  );
}
