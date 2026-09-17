import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { authenticate } from "@/middleware/auth.js";
import { cacheControl } from "@/middleware/cacheControl.js";
import { compression } from "@/middleware/compression.js";
import { errorHandler, notFoundHandler } from "@/middleware/errorHandler.js";
import { rateLimit } from "@/middleware/rateLimit.js";
import { requestContext } from "@/middleware/requestContext.js";
import { stripeWebhookHandler } from "@/modules/payments/payments.webhook.js";
import { apiRouter } from "@/routes.js";

/** Builds the Express application. Kept free of side effects so tests can import it. */
export function createApp(): Express {
  const app = express();

  // Behind the hosting proxy, so `req.ip` is the real client address.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  // Strong-ish ETags let browsers revalidate big listing payloads with a 304.
  app.set("etag", "strong");
  app.set("query parser", "simple");

  // Compresses JSON responses before anything writes a body.
  app.use(compression());

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  // Any origin may call the API. The request origin is reflected (instead of
  // "*") so that credentialed browser requests are accepted too.
  app.use(
    cors({
      origin: (_origin, callback) => callback(null, true),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin", "stripe-signature"],
      exposedHeaders: ["x-request-id"],
      maxAge: 86400,
      optionsSuccessStatus: 204,
    }),
  );
  app.options(/.*/, cors({ origin: (_origin, callback) => callback(null, true), credentials: true }));

  // Stripe signs the exact bytes it sent, so the webhook needs the raw body
  // and must be registered before the JSON parser.
  app.post("/api/payments/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    void stripeWebhookHandler(req, res);
  });

  // Listings carry up to ten inline photos, so the JSON body can be large.
  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // Request id + per-request logger, before anything that may log or fail.
  app.use(requestContext);

  // A broad safety net; the auth routes add their own tighter limiter.
  app.use(rateLimit({ name: "global", windowMs: 60_000, max: 600 }));

  // Attaches `req.auth` when a token is present, without rejecting anonymous calls.
  app.use(authenticate);

  // Cache hints: short CDN caching for anonymous catalogue reads, no-store elsewhere.
  app.use(cacheControl);

  app.get("/", (_req, res) => {
    res.json({ service: "nestara-backend", docs: "/api/docs", openapi: "/api/docs/openapi.json", health: "/api/health", version: "1.0.0" });
  });

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
