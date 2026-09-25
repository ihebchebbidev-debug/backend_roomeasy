import type { RequestHandler } from "express";

import { apiError } from "@/core/errors.js";
import { log } from "@/core/logger.js";
import { queryOne, query } from "@/db/query.js";

/**
 * Fixed-window limiter stored in the database, so counters survive a server
 * restart and are shared between instances. It stops credential and
 * reset-code guessing (the reset code is only four digits).
 *
 * If the database cannot be reached the limiter falls back to an in-process
 * counter rather than letting every attempt through.
 */

const logger = log("rate-limit");

type Hit = { count: number; resetAt: number };
const fallback = new Map<string, Hit>();
let lastSweep = 0;

function clientKey(req: { ip?: string; socket?: { remoteAddress?: string | undefined } }): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

async function hitStored(key: string, windowMs: number): Promise<Hit> {
  const row = await queryOne<{ count: number; reset_at: Date }>(
    `INSERT INTO rate_limit_bucket (key, count, reset_at)
     VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limit_bucket.reset_at <= now() THEN 1 ELSE rate_limit_bucket.count + 1 END,
       reset_at = CASE WHEN rate_limit_bucket.reset_at <= now()
                       THEN now() + ($2::int * interval '1 millisecond')
                       ELSE rate_limit_bucket.reset_at END
     RETURNING count, reset_at`,
    [key, windowMs],
    { label: "rateLimit.hit" },
  );
  const now = Date.now();
  if (now - lastSweep > 10 * 60_000) {
    lastSweep = now;
    void query("DELETE FROM rate_limit_bucket WHERE reset_at < now() - interval '1 hour'", [], {
      label: "rateLimit.sweep",
    }).catch(() => undefined);
  }
  return { count: Number(row!.count), resetAt: new Date(row!.reset_at).getTime() };
}

function hitMemory(key: string, windowMs: number): Hit {
  const now = Date.now();
  const hit = fallback.get(key);
  if (!hit || hit.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    fallback.set(key, fresh);
    return fresh;
  }
  hit.count += 1;
  return hit;
}

export function rateLimit(options: { windowMs: number; max: number; name: string }): RequestHandler {
  return (req, res, next) => {
    const key = `${options.name}:${clientKey(req)}`;
    hitStored(key, options.windowMs)
      .catch((error: unknown) => {
        logger.warn({ err: error }, "rate limit store unavailable, using memory");
        return hitMemory(key, options.windowMs);
      })
      .then((hit) => {
        if (hit.count > options.max) {
          const retryAfter = Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));
          res.setHeader("Retry-After", String(retryAfter));
          return next(
            apiError("RATE_LIMITED", {
              message: "Too many attempts. Please wait a moment and try again.",
              details: { retryAfterSeconds: retryAfter },
            }),
          );
        }
        return next();
      }, next);
  };
}
