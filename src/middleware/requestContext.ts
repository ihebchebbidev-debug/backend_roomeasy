import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { logger } from "@/core/logger.js";

/**
 * Gives every request an id and its own child logger, then logs one line when
 * the response finishes (method, path, status, duration, user, request id).
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  req.id = incoming && incoming.length <= 64 ? incoming : randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.setHeader("x-request-id", req.id);

  const startedAt = process.hrtime.bigint();

  req.log.debug({ method: req.method, url: req.originalUrl, ip: req.ip }, "request received");

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const payload = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Number(ms.toFixed(2)),
      userId: req.auth?.userId,
      roles: req.auth?.roles,
      ip: req.ip,
    };
    if (res.statusCode >= 500) req.log.error(payload, "request failed");
    else if (res.statusCode >= 400) req.log.warn(payload, "request rejected");
    else req.log.info(payload, "request completed");
  });

  next();
}
