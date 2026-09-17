import { query, queryOne } from "@/db/query.js";

export type PlatformSettings = {
  serviceFeeRate: number;
  taxRate: number;
  commissionRate: number;
  rateRules: { weekend: number; longStay: number; lastMinute: number };
  updatedAt: string;
};

type SettingsRow = {
  service_fee_rate: string;
  tax_rate: string;
  commission_rate: string;
  rate_weekend_percent: string;
  rate_long_stay_percent: string;
  rate_last_minute_percent: string;
  updated_at: Date;
};

function mapSettings(row: SettingsRow): PlatformSettings {
  return {
    serviceFeeRate: Number(row.service_fee_rate),
    taxRate: Number(row.tax_rate),
    commissionRate: Number(row.commission_rate),
    rateRules: {
      weekend: Number(row.rate_weekend_percent),
      longStay: Number(row.rate_long_stay_percent),
      lastMinute: Number(row.rate_last_minute_percent),
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The settings row is read on nearly every quote, so it is cached briefly. */
let cache: { value: PlatformSettings; expiresAt: number } | null = null;
const CACHE_MS = 15_000;

export async function getPlatformSettings(options: { fresh?: boolean } = {}): Promise<PlatformSettings> {
  if (!options.fresh && cache && cache.expiresAt > Date.now()) return cache.value;

  const row = await queryOne<SettingsRow>(
    `INSERT INTO platform_settings (id) VALUES (true)
       ON CONFLICT (id) DO UPDATE SET id = true
     RETURNING *`,
    [],
    { label: "settings.get" },
  );
  const value = mapSettings(row as SettingsRow);
  cache = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

export async function updatePlatformSettings(patch: {
  serviceFeeRate?: number;
  taxRate?: number;
  commissionRate?: number;
  weekend?: number;
  longStay?: number;
  lastMinute?: number;
}): Promise<PlatformSettings> {
  const row = await queryOne<SettingsRow>(
    `UPDATE platform_settings SET
       service_fee_rate         = coalesce($1, service_fee_rate),
       tax_rate                 = coalesce($2, tax_rate),
       commission_rate          = coalesce($3, commission_rate),
       rate_weekend_percent     = coalesce($4, rate_weekend_percent),
       rate_long_stay_percent   = coalesce($5, rate_long_stay_percent),
       rate_last_minute_percent = coalesce($6, rate_last_minute_percent),
       updated_at               = now()
     WHERE id = true
     RETURNING *`,
    [
      patch.serviceFeeRate ?? null,
      patch.taxRate ?? null,
      patch.commissionRate ?? null,
      patch.weekend ?? null,
      patch.longStay ?? null,
      patch.lastMinute ?? null,
    ],
    { label: "settings.update" },
  );
  cache = null;
  return mapSettings(row as SettingsRow);
}

export type HostRateRules = { weekend: number; longStay: number; lastMinute: number };

/** Host override, falling back to the platform defaults. */
export async function getHostRateRules(hostId: string | null): Promise<HostRateRules> {
  const platform = await getPlatformSettings();
  if (!hostId) return platform.rateRules;

  const row = await queryOne<{ weekend_percent: string; long_stay_percent: string; last_minute_percent: string }>(
    `SELECT weekend_percent, long_stay_percent, last_minute_percent FROM host_rate_rules WHERE host_id = $1`,
    [hostId],
    { label: "settings.hostRateRules" },
  );
  if (!row) return platform.rateRules;
  return {
    weekend: Number(row.weekend_percent),
    longStay: Number(row.long_stay_percent),
    lastMinute: Number(row.last_minute_percent),
  };
}

export async function saveHostRateRules(hostId: string, rules: HostRateRules): Promise<HostRateRules> {
  const row = await queryOne<{ weekend_percent: string; long_stay_percent: string; last_minute_percent: string }>(
    `INSERT INTO host_rate_rules (host_id, weekend_percent, long_stay_percent, last_minute_percent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (host_id) DO UPDATE
       SET weekend_percent = excluded.weekend_percent,
           long_stay_percent = excluded.long_stay_percent,
           last_minute_percent = excluded.last_minute_percent,
           updated_at = now()
     RETURNING weekend_percent, long_stay_percent, last_minute_percent`,
    [hostId, rules.weekend, rules.longStay, rules.lastMinute],
    { label: "settings.saveHostRateRules" },
  );
  return {
    weekend: Number(row!.weekend_percent),
    longStay: Number(row!.long_stay_percent),
    lastMinute: Number(row!.last_minute_percent),
  };
}

export async function listExchangeRates(): Promise<{ quote: string; rate: number; fetchedAt: string }[]> {
  const rows = await query<{ quote_currency: string; rate: string; fetched_at: Date }>(
    `SELECT quote_currency, rate, fetched_at FROM exchange_rate WHERE base_currency = 'USD' ORDER BY quote_currency`,
    [],
    { label: "settings.listExchangeRates" },
  );
  return rows.map((row) => ({ quote: row.quote_currency.trim(), rate: Number(row.rate), fetchedAt: row.fetched_at.toISOString() }));
}

export async function saveExchangeRates(rates: Record<string, number>): Promise<void> {
  const entries = Object.entries(rates);
  if (!entries.length) return;
  await query(
    `INSERT INTO exchange_rate (base_currency, quote_currency, rate, fetched_at)
     SELECT 'USD', quote, rate, now() FROM unnest($1::text[], $2::numeric[]) AS t(quote, rate)
     ON CONFLICT (base_currency, quote_currency)
       DO UPDATE SET rate = excluded.rate, fetched_at = now()`,
    [entries.map(([quote]) => quote), entries.map(([, rate]) => rate)],
    { label: "settings.saveExchangeRates" },
  );
}
