import { log } from "@/core/logger.js";
import { reconcileSchema } from "@/db/migrate.js";
import { closePool, databaseTarget } from "@/db/pool.js";

/** `npm run migrate` — brings the database in line with the registry, then exits. */
const logger = log("migrate-cli");

async function main(): Promise<void> {
  logger.info({ database: databaseTarget() }, "reconciling schema");
  const started = Date.now();
  const report = await reconcileSchema();
  logger.info({ ...report, durationMs: Date.now() - started }, "schema is up to date");
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.fatal({ err: error }, "migration failed");
    await closePool().catch(() => undefined);
    process.exit(1);
  });
