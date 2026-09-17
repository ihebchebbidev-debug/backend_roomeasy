import { Router } from "express";

import { asyncHandler, ok } from "@/core/http.js";
import { databaseTarget } from "@/db/pool.js";
import { docsRouter } from "@/docs/docs.routes.js";
import { queryOne } from "@/db/query.js";
import { accountsRouter } from "@/modules/accounts/accounts.routes.js";
import { adminRouter } from "@/modules/admin/admin.routes.js";
import { bookingsRouter } from "@/modules/bookings/bookings.routes.js";
import { currencyRouter } from "@/modules/currency/currency.routes.js";
import { equipmentRouter } from "@/modules/equipment/equipment.routes.js";
import { favoritesRouter } from "@/modules/favorites/favorites.routes.js";
import { hostRouter } from "@/modules/host/host.routes.js";
import { listingsRouter } from "@/modules/listings/listings.routes.js";
import { messagingRouter } from "@/modules/messaging/messaging.routes.js";
import { paymentsRouter } from "@/modules/payments/payments.routes.js";
import { propertiesRouter } from "@/modules/properties/properties.routes.js";
import { reviewsRouter } from "@/modules/reviews/reviews.routes.js";
import { settingsRouter } from "@/modules/settings/settings.routes.js";
import { supportRouter } from "@/modules/support/support.routes.js";

/**
 * The single place where every feature module is mounted. One folder per group
 * of functionality; the prefix here is the only thing the front-end needs.
 */
export const apiRouter = Router();

/** Liveness: the process answers. */
apiRouter.get(
  "/health",
  asyncHandler(async (_req, res) => ok(res, { status: "ok", uptimeSeconds: Math.round(process.uptime()) })),
);

/** Readiness: the process answers *and* the database does. */
apiRouter.get(
  "/health/ready",
  asyncHandler(async (_req, res) => {
    const row = await queryOne<{ now: Date }>("SELECT now() AS now", [], { label: "health.ready" });
    return ok(res, { status: "ready", database: databaseTarget(), serverTime: row?.now.toISOString() });
  }),
);

apiRouter.use("/docs", docsRouter);

apiRouter.use("/accounts", accountsRouter);
apiRouter.use("/stays", propertiesRouter);
apiRouter.use("/equipment", equipmentRouter);
apiRouter.use("/favorites", favoritesRouter);
apiRouter.use("/listings", listingsRouter);
apiRouter.use("/bookings", bookingsRouter);
apiRouter.use("/reviews", reviewsRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/host", hostRouter);
apiRouter.use("/messaging", messagingRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/support", supportRouter);
apiRouter.use("/settings", settingsRouter);
apiRouter.use("/currency", currencyRouter);
