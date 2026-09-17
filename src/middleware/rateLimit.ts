import type { RequestHandler } from "express";

import { apiError } from "@/core/errors.js";

type Bucket = { count: number; resetAt: number };

/**
 * Small in-process limiter, used on the sensitive auth routes. It is per
 * instance on purpose: move it to Redis before running several replicas.
 */
export function rateLimit(options: { windowMs: number; max: number; name: string }): RequestHandler {
  const buckets = new Map<string, Bucket>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }, options.windowMs).unref();

  return (req, res, next) => {
    const key = `${options.name}:${req.ip ?? "unknown"}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("retry-after", String(retryAfter));
      req.log?.warn({ limiter: options.name, ip: req.ip, count: bucket.count }, "rate limit hit");
      return next(
        apiError("RATE_LIMITED", {
          message: `Too many attempts. Try again in ${retryAfter} second(s).`,
          details: { retryAfterSeconds: retryAfter },
        }),
      );
    }

    next();
  };
}
