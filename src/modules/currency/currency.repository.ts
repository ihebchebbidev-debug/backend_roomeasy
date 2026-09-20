import { log } from "@/core/logger.js";
import { listExchangeRates, saveExchangeRates } from "@/modules/settings/settings.repository.js";

/**
 * EUR-based exchange rates. The app shows prices in EUR, USD, GBP, CHF and BRL
 * (`src/i18n/CurrencyProvider.tsx`), so those are the quotes kept fresh here.
 *
 * Rates come from the live provider and are cached in the `exchange_rate`
 * table. A refresh is attempted when the stored rates are older than
 * `MAX_AGE_MS`; if the provider is unreachable the last known live rates are
 * served, and if there are none only EUR is quoted.
 */

const logger = log("currency");

export const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "BRL"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

const MAX_AGE_MS = 60 * 60 * 1000; // one hour
const PROVIDER_URL = "https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,CHF,BRL";
const PROVIDER_TIMEOUT_MS = 5000;

export type RatesPayload = {
  base: "EUR";
  rates: Record<string, number>;
  fetchedAt: string | null;
  source: "provider" | "cache" | "unavailable";
};

async function fetchFromProvider(): Promise<Record<string, number> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(PROVIDER_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "exchange-rate provider returned an error status");
      return null;
    }
    const payload = (await response.json()) as { rates?: Record<string, number> };
    if (!payload.rates || typeof payload.rates !== "object") {
      logger.warn("exchange-rate provider returned an unexpected payload");
      return null;
    }
    return { ...payload.rates, EUR: 1 };
  } catch (error) {
    logger.warn({ err: error }, "exchange-rate provider unreachable — serving cached rates");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the cached rates, refreshing them from the provider when stale. */
export async function getRates(options: { force?: boolean } = {}): Promise<RatesPayload> {
  const stored = await listExchangeRates();
  const newest = stored.reduce<string | null>(
    (latest, row) => (latest === null || row.fetchedAt > latest ? row.fetchedAt : latest),
    null,
  );
  const stale = !newest || Date.now() - Date.parse(newest) > MAX_AGE_MS;

  if (options.force || stale) {
    const fresh = await fetchFromProvider();
    if (fresh) {
      await saveExchangeRates(fresh);
      logger.info({ quotes: Object.keys(fresh).length }, "exchange rates refreshed");
      return { base: "EUR", rates: { EUR: 1, ...fresh }, fetchedAt: new Date().toISOString(), source: "provider" };
    }
  }

  if (stored.length) {
    const rates: Record<string, number> = { EUR: 1 };
    for (const row of stored) rates[row.quote] = row.rate;
    return { base: "EUR", rates, fetchedAt: newest, source: "cache" };
  }

  // No hardcoded rate table: a stale constant would quote guests a wrong
  // price, so callers are told that only EUR is available.
  logger.warn("no exchange rates available — quoting EUR only");
  return { base: "EUR", rates: { EUR: 1 }, fetchedAt: null, source: "unavailable" };
}

/** Converts a USD amount into another supported currency. */
export async function convertFromUsd(amountUsd: number, currency: string): Promise<{ amount: number; rate: number }> {
  const { rates } = await getRates();
  const rate = rates[currency.toUpperCase()] ?? 1;
  return { amount: Number((amountUsd * rate).toFixed(2)), rate };
}
