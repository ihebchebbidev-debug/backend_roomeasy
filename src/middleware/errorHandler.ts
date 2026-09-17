import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import { isProduction } from "@/config/env.js";
import { ApiError, apiError, isApiError } from "@/core/errors.js";

/** 404 for any URL that no router matched. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(
    apiError("ROUTE_NOT_FOUND", {
      message: `No API route matches ${req.method} ${req.path}.`,
      details: { method: req.method, path: req.path },
    }),
  );
};

type BodyParserError = Error & { type?: string; status?: number };

function normalise(error: unknown): ApiError {
  if (isApiError(error)) return error;

  if (error instanceof ZodError) {
    return apiError("VALIDATION_FAILED", {
      issues: error.issues.map((issue) => ({
        field: issue.path.join(".") || "(body)",
        message: issue.message,
        rule: issue.code,
      })),
      cause: error,
    });
  }

  const parserError = error as BodyParserError;
  if (parserError?.type === "entity.parse.failed") return apiError("MALFORMED_JSON", { cause: error });
  if (parserError?.type === "entity.too.large") return apiError("PAYLOAD_TOO_LARGE", { cause: error });
  if (parserError?.type === "encoding.unsupported") return apiError("UNSUPPORTED_MEDIA_TYPE", { cause: error });

  return apiError("INTERNAL", { cause: error });
}

/**
 * The single place that turns anything thrown into an HTTP response.
 * Response shape: `{ error: { code, message, issues?, details? }, requestId }`.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const failure = normalise(error);
  const cause = failure.cause ?? error;

  const logPayload = {
    code: failure.code,
    status: failure.status,
    method: req.method,
    url: req.originalUrl,
    userId: req.auth?.userId,
    issues: failure.issues,
    details: failure.details,
    err: cause instanceof Error ? cause : undefined,
  };

  const log: Pick<Console, "error" | "warn"> = req.log ?? console;
  if (failure.status >= 500) log.error(logPayload, failure.message);
  else log.warn(logPayload, failure.message);

  const body = {
    error: {
      ...failure.toJSON(),
      ...(isProduction || !(cause instanceof Error) ? {} : { debug: { name: cause.name, message: cause.message } }),
    },
    requestId: req.id,
  };

  res.status(failure.status).json(body);
};
