/**
 * One-shot: rebase every forward-looking price from USD to EUR.
 *
 * Uses the platform's own exchange-rate service (same provider and cache as
 * GET /currency/rates) so the conversion happens at the live rate, then runs
 * db/2026-09-eur-rebase.sql against DATABASE_URL in a single transaction.
 *
 * Run:  npm run rebase:eur
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { log } from "@/core/logger.js";
import { closePool, databaseTarget, withClient } from "@/db/pool.js";
import { getRates } from "@/modules/currency/currency.repository.js";

const logger = log("eur-rebase-cli");

async function main(): Promise<void> {
  const { rates, source, fetchedAt } = await getRates({ force: true });
  const usdPerEur = rates.USD;
  if (!usdPerEur || usdPerEur <= 0) {
    throw new Error("No USD rate available — cannot convert safely.");
  }
  // Rates are EUR-based: 1 EUR = usdPerEur USD, so 1 USD = 1/usdPerEur EUR.
  const rate = 1 / usdPerEur;
  logger.info({ usdPerEur, rate, source, fetchedAt }, "USD -> EUR conversion rate");

  const sqlPath = path.resolve(import.meta.dirname, "../../../db/2026-09-eur-rebase.sql");
  const raw = await readFile(sqlPath, "utf8");
  // The SQL file is written for psql's :rate variable; inject the live value.
  const sql = raw.replaceAll(":rate", rate.toFixed(6));

  logger.info({ database: databaseTarget() }, "converting USD prices to EUR");
  await withClient((client) => client.query(sql));
  logger.info("all USD prices converted to EUR at the live rate");
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.fatal({ err: error }, "EUR rebase failed");
    await closePool().catch(() => undefined);
    process.exit(1);
  });
