import type { RequestHandler } from "express";

import { apiError } from "@/core/errors.js";

/**
 * Small in-process fixed-window limiter. It exists to stop credential and
 * reset-code guessing: the confirmation code is only four digits, so an
 * unthrottled endpoint can be walked through in seconds.
 *
 * One process holds its own counters. That is enough for the abuse this
 * guards against; a shared store can replace the map later without touching
 * any call site.
 */

type Hit = { count: number; resetAt: number };

const buckets = new Map<string, Hit>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hit] of buckets) if (hit.resetAt <= now) buckets.delete(key);
}

function clientKey(req: { ip?: string; socket?: { remoteAddress?: string | undefined } }): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function rateLimit(options: { windowMs: number; max: number; name: string }): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = `${options.name}:${clientKey(req)}`;
    const hit = buckets.get(key);

    if (!hit || hit.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    hit.count += 1;
    if (hit.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return next(
        apiError("RATE_LIMITED", {
          message: "Too many attempts. Please wait a moment and try again.",
          details: { retryAfterSeconds: retryAfter },
        }),
      );
    }

    return next();
  };
}
