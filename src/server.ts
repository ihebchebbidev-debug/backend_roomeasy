import type { Server } from "node:http";

import { createApp } from "@/app.js";
import { env, isProduction } from "@/config/env.js";
import { log } from "@/core/logger.js";
import { reconcileSchema } from "@/db/migrate.js";
import { syncEquipmentCatalogue } from "@/db/sync-equipment.js";
import { seedTaxonomy } from "@/modules/admin/taxonomy.repository.js";
import { seedCatalog } from "@/modules/admin/catalog.repository.js";
import { closePool, databaseTarget } from "@/db/pool.js";
import { startBookingMaintenanceWorker, stopBookingMaintenanceWorker } from "@/modules/bookings/bookings.maintenance.js";
import { startNotificationWorker, stopNotificationWorker } from "@/modules/notifications/dispatcher.js";
import { mailerStatus } from "@/modules/notifications/mailer.js";
import { stripeStatus } from "@/modules/payments/stripe.client.js";

const logger = log("server");

async function bootstrap(): Promise<void> {
  logger.info({ env: env.NODE_ENV, database: databaseTarget() }, "starting api");

  if (env.AUTO_MIGRATE) {
    const started = Date.now();
    const report = await reconcileSchema();
    logger.info({ ...report, durationMs: Date.now() - started }, "database schema reconciled");
  } else {
    logger.warn("AUTO_MIGRATE is off — the schema is assumed to be up to date");
  }

  // The amenity catalogue is reference data the listing form validates against,
  // so it is kept in sync on every boot.
  try {
    const count = await syncEquipmentCatalogue();
    logger.info({ count }, "equipment catalogue synced");
  } catch (error) {
    logger.error({ err: error }, "equipment catalogue sync failed");
  }

  // Default property types and countries, inserted once; admin edits are kept.
  try {
    const seeded = await seedTaxonomy();
    logger.info(seeded, "property types and countries ready");
  } catch (error) {
    logger.error({ err: error }, "property type / country seed failed");
  }

  // Default cities and Terms/Privacy/Help pages, inserted once; admin edits are kept.
  try {
    const seeded = await seedCatalog();
    logger.info(seeded, "default cities and pages ready");
  } catch (error) {
    logger.error({ err: error }, "city / page seed failed");
  }

  const mail = mailerStatus();
  const stripe = stripeStatus();
  logger.info(
    { smtpConfigured: mail.configured, smtpHost: mail.host, stripeEnabled: stripe.enabled, stripeMode: stripe.mode },
    mail.configured && stripe.enabled
      ? "email and payments are configured"
      : "email/payment credentials still missing — those features stay idle until they are filled in",
  );

  startNotificationWorker();
  startBookingMaintenanceWorker();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, url: `http://localhost:${env.PORT}` }, "api listening");
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.fatal({ port: env.PORT }, `Port ${env.PORT} is already in use. Stop the other process or set PORT.`);
    } else {
      logger.fatal({ err: error }, "the http server failed to start");
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    stopNotificationWorker();
    stopBookingMaintenanceWorker();
    const timer = setTimeout(() => {
      logger.error("shutdown took too long — forcing exit");
      process.exit(1);
    }, 10_000);
    timer.unref();

    server.close(async (error) => {
      if (error) logger.error({ err: error }, "error while closing the http server");
      await closePool().catch((poolError) => logger.error({ err: poolError }, "error while closing the pool"));
      logger.info("shutdown complete");
      process.exit(error ? 1 : 0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandled promise rejection");
    if (!isProduction) throw reason;
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception — exiting");
    process.exit(1);
  });
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, "the api failed to start");
  process.exit(1);
});
