import type { Request } from "express";
import { z, type ZodTypeAny } from "zod";

import { apiError, type FieldIssue } from "@/core/errors.js";

function toIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(body)",
    message: issue.message,
    rule: issue.code,
  }));
}

function parse<S extends ZodTypeAny>(schema: S, value: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw apiError("VALIDATION_FAILED", {
      message: `The request ${source} is invalid.`,
      issues: toIssues(result.error),
      details: { source },
    });
  }
  return result.data;
}

export function validateBody<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parse(schema, req.body ?? {}, "body");
}

export function validateQuery<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parse(schema, req.query ?? {}, "query string");
}

export function validateParams<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return parse(schema, req.params ?? {}, "URL parameters");
}

/** Reusable field schemas shared by several modules. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "That date does not exist.");

export const timeOfDay = z.string().regex(/^\d{1,2}:\d{2}$/, "Use the HH:MM time format.");

/**
 * A boolean inside a query string. `z.coerce.boolean()` reads the text
 * "false" as true, so the two words are parsed explicitly instead.
 */
export function queryBoolean(fallback?: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (typeof value === "boolean") return value;
      if (value === undefined || value.trim() === "") return fallback;
      return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    });
}

export const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(160);

export const password = z.string().min(8, "Use at least 8 characters for the password.").max(200);

export const idParam = z.object({ id: z.string().trim().min(1, "An id is required.").max(120) });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
