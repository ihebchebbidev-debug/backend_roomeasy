import { env } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { reconcileSchema } from "@/db/migrate.js";
import { closePool, databaseTarget } from "@/db/pool.js";
import { query } from "@/db/query.js";
import { DEMO_ACCOUNTS } from "@/db/seed-data.js";
import { syncEquipmentCatalogue } from "@/db/sync-equipment.js";
import { createAccount, findAccountByEmail, grantRole } from "@/modules/accounts/accounts.repository.js";
import type { Role } from "@/middleware/auth.js";

/**
 * `npm run seed` — loads the reference data the app relies on (amenity
 * catalogue, the single settings row, the trusted-guest rule) and, outside
 * production, three demo logins. Safe to run repeatedly.
 */
const logger = log("seed-cli");

async function seedPlatformSettings(): Promise<void> {
  await query(`INSERT INTO platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`, [], {
    label: "seed.platformSettings",
  });
  await query(
    `INSERT INTO trust_badge_rule (code, min_reservations, window_months, requires_verified_account, active)
     VALUES ('genuse', 5, 24, true, true)
     ON CONFLICT (code) DO NOTHING`,
    [],
    { label: "seed.trustBadgeRule" },
  );
}

async function seedDemoAccounts(): Promise<number> {
  let createdCount = 0;
  for (const demo of DEMO_ACCOUNTS) {
    const existing = await findAccountByEmail(demo.email);
    if (existing) {
      for (const role of demo.roles as readonly Role[]) {
        if (!existing.roles.includes(role)) await grantRole(existing.id, role, demo.fullName);
      }
      logger.info({ email: demo.email }, "demo account already present — roles checked");
      continue;
    }
    await createAccount({
      fullName: demo.fullName,
      email: demo.email,
      password: demo.password,
      roles: [...demo.roles] as Role[],
    });
    createdCount += 1;
    logger.info({ email: demo.email, roles: demo.roles }, "demo account created");
  }
  return createdCount;
}

async function main(): Promise<void> {
  logger.info({ database: databaseTarget() }, "seeding reference data");

  if (env.AUTO_MIGRATE) await reconcileSchema();

  const equipment = await syncEquipmentCatalogue();
  await seedPlatformSettings();

  let demoAccounts = 0;
  if (env.NODE_ENV === "production") {
    logger.warn("NODE_ENV is production — demo accounts were skipped");
  } else {
    demoAccounts = await seedDemoAccounts();
  }

  logger.info({ equipment, demoAccounts }, "seed complete");
  if (demoAccounts > 0) {
    logger.info(
      DEMO_ACCOUNTS.map((account) => `${account.email} / ${account.password}`),
      "demo logins (development only — change or remove before going live)",
    );
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.fatal({ err: error }, "seeding failed");
    await closePool().catch(() => undefined);
    process.exit(1);
  });
