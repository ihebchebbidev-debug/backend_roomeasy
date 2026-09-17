import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { reconcileSchema } from "@/db/migrate.js";
import { closePool, databaseTarget } from "@/db/pool.js";
import { query } from "@/db/query.js";
import { DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, seedDemoData } from "@/db/seed-demo.js";
import { syncEquipmentCatalogue } from "@/db/sync-equipment.js";

/**
 * `npm run seed:demo` — rebuilds a complete demonstration dataset:
 * 54 French listings, hosts, guests, staff, bookings, payments, reviews,
 * payouts, messages, tickets and moderation history.
 *
 * Re-running it removes the previous demo rows first, so it never duplicates.
 * It only touches rows it owns (ids prefixed `demo-`, e-mails on
 * @demo.roomeasy.fr) — real production data is left untouched.
 */
const logger = log("seed-demo-cli");

async function main(): Promise<void> {
  logger.info({ database: databaseTarget() }, "building the demo dataset");

  if (env.AUTO_MIGRATE) await reconcileSchema();
  await syncEquipmentCatalogue();
  await query(`INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`, [], {
    label: "seed-demo.platformSettings",
  });

  const report = await seedDemoData();
  logger.info(report, "demo dataset created");
  logger.info(
    { password: DEMO_PASSWORD, admin: `admin@${DEMO_EMAIL_DOMAIN}`, support: `support@${DEMO_EMAIL_DOMAIN}` },
    "demo logins — every demo account shares the same password",
  );
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.fatal({ err: error }, "demo seeding failed");
    await closePool().catch(() => undefined);
    process.exit(1);
  });
