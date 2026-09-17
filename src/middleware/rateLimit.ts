import type { RequestHandler } from "express";

/**
 * Rate limiting is disabled platform-wide by product decision: no request is
 * ever refused with RATE_LIMITED. The factory is kept so the existing call
 * sites stay unchanged and a limiter can be reinstated in one place later.
 */
export function rateLimit(_options: { windowMs: number; max: number; name: string }): RequestHandler {
  return (_req, _res, next) => next();
}
