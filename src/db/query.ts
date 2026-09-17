import { randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import { env } from "@/config/env.js";
import { ApiError, apiError, type ApiErrorCode } from "@/core/errors.js";
import { log } from "@/core/logger.js";
import { pool, withClient } from "@/db/pool.js";
import { reconcileSchema } from "@/db/migrate.js";

const logger = log("db.query");

/** PostgreSQL error classes we translate into API errors. */
const pgCodes = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  exclusionViolation: "23P01",
  invalidTextRepresentation: "22P02",
  undefinedColumn: "42703",
  undefinedTable: "42P01",
  undefinedObject: "42704",
  invalidEnumInput: "22P02",
  connectionFailure: "08006",
  cannotConnectNow: "57P03",
} as const;

type PgError = Error & { code?: string; detail?: string; constraint?: string; table?: string; column?: string };

function isPgError(value: unknown): value is PgError {
  return value instanceof Error && typeof (value as PgError).code === "string";
}

/** Constraint name → API error code, so a DB guard surfaces a clean message. */
const constraintErrors: Record<string, { code: ApiErrorCode; message: string }> = {
  booking_no_overlap: { code: "UNAVAILABLE", message: "Those nights were just taken by another booking." },
  app_user_email_key: { code: "EMAIL_TAKEN", message: "An account already uses this email address." },
  property_photo_property_id_position_key: {
    code: "VALIDATION_FAILED",
    message: "Two photos cannot share the same position.",
  },
  favorite_pkey: { code: "CONFLICT", message: "This stay is already in your favourites." },
  review_booking_id_key: { code: "ALREADY_REVIEWED", message: "This stay has already been reviewed." },
  property_pkey: { code: "PROPERTY_ID_TAKEN", message: "Another listing already uses this address slug." },
  payment_reference_key: { code: "CONFLICT", message: "This payment was already recorded." },
};

export function translateDatabaseError(error: unknown, context: { sql?: string } = {}) {
  // An ApiError thrown inside a transaction already carries its own code and
  // status; it must not be mistaken for a PostgreSQL error and become a 500.
  if (error instanceof ApiError) return error;
  if (!isPgError(error)) return error;

  const constraint = error.constraint ?? "";
  const mapped = constraintErrors[constraint];
  if (mapped) {
    return apiError(mapped.code, { message: mapped.message, details: { constraint }, cause: error });
  }

  switch (error.code) {
    case pgCodes.uniqueViolation:
      return apiError("CONFLICT", {
        message: "That value is already used by another record.",
        details: { constraint, detail: error.detail },
        cause: error,
      });
    case pgCodes.foreignKeyViolation:
      return apiError("VALIDATION_FAILED", {
        message: "A referenced record does not exist.",
        details: { constraint, detail: error.detail },
        cause: error,
      });
    case pgCodes.checkViolation:
      return apiError("VALIDATION_FAILED", {
        message: `A value failed the database rule "${constraint}".`,
        details: { constraint },
        cause: error,
      });
    case pgCodes.notNullViolation:
      return apiError("VALIDATION_FAILED", {
        message: `"${error.column ?? "a required field"}" must be provided.`,
        details: { column: error.column, table: error.table },
        cause: error,
      });
    case pgCodes.exclusionViolation:
      return apiError("UNAVAILABLE", {
        message: "Those nights overlap an existing booking.",
        details: { constraint },
        cause: error,
      });
    case pgCodes.invalidTextRepresentation:
      return apiError("VALIDATION_FAILED", {
        message: "A value has the wrong format for its column.",
        details: { detail: error.detail ?? error.message },
        cause: error,
      });
    case pgCodes.connectionFailure:
    case pgCodes.cannotConnectNow:
      return apiError("DATABASE_UNAVAILABLE", { cause: error });
    default:
      return apiError("INTERNAL", {
        message: "A database operation failed.",
        details: { pgCode: error.code, sql: context.sql?.slice(0, 200) },
        cause: error,
      });
  }
}

function isMissingSchemaError(error: unknown): boolean {
  if (!isPgError(error)) return false;
  return (
    error.code === pgCodes.undefinedColumn ||
    error.code === pgCodes.undefinedTable ||
    error.code === pgCodes.undefinedObject
  );
}

export type Sql = { text: string; values?: unknown[] };

let healingInFlight: Promise<void> | null = null;

/**
 * Runs the schema reconciler at most once at a time, so a burst of requests
 * hitting the same missing column triggers a single repair.
 */
async function healOnce(reason: string): Promise<void> {
  if (!healingInFlight) {
    healingInFlight = reconcileSchema({ trigger: `auto-heal:${reason}` })
      .then(() => undefined)
      .finally(() => {
        healingInFlight = null;
      });
  }
  return healingInFlight;
}

/**
 * The single entry point for every SQL statement.
 *
 * - tags each statement with a query id and logs duration
 * - converts PostgreSQL errors into typed API errors
 * - when `AUTO_HEAL` is on and the failure is "column/table does not exist",
 *   it reconciles the schema (creating the missing table, column, index or
 *   enum value) and retries the statement once
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  options: { client?: PoolClient; allowHeal?: boolean; label?: string } = {},
): Promise<T[]> {
  const executor = options.client ?? pool;
  const queryId = randomUUID().slice(0, 8);
  const startedAt = process.hrtime.bigint();

  try {
    const result = await executor.query<T>(text, values);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.debug(
      { queryId, label: options.label, rows: result.rowCount, ms: Number(ms.toFixed(2)) },
      "sql ok",
    );
    if (ms > 500) {
      logger.warn({ queryId, label: options.label, ms: Number(ms.toFixed(2)), sql: text.slice(0, 300) }, "slow query");
    }
    return result.rows;
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const shouldHeal = env.AUTO_HEAL && options.allowHeal !== false && isMissingSchemaError(error);

    logger.error(
      {
        queryId,
        label: options.label,
        ms: Number(ms.toFixed(2)),
        sql: text.slice(0, 500),
        pgCode: isPgError(error) ? error.code : undefined,
        err: error,
        willHeal: shouldHeal,
      },
      "sql failed",
    );

    if (shouldHeal) {
      const message = error instanceof Error ? error.message : "unknown";
      logger.warn({ queryId, message }, "missing schema object detected — repairing schema and retrying");
      await healOnce(message.slice(0, 120));
      try {
        const retry = await executor.query<T>(text, values);
        logger.info({ queryId, rows: retry.rowCount }, "statement succeeded after schema repair");
        return retry.rows;
      } catch (retryError) {
        throw translateDatabaseError(retryError, { sql: text });
      }
    }

    throw translateDatabaseError(error, { sql: text });
  }
}

/** First row or `null`. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
  options: { client?: PoolClient; label?: string } = {},
): Promise<T | null> {
  const rows = await query<T>(text, values, options);
  return rows[0] ?? null;
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>, label = "tx"): Promise<T> {
  return withClient(async (client) => {
    const startedAt = Date.now();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      logger.debug({ label, ms: Date.now() - startedAt }, "transaction committed");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error({ err: rollbackError, label }, "rollback failed");
      }
      logger.warn({ label, ms: Date.now() - startedAt }, "transaction rolled back");
      throw translateDatabaseError(error);
    }
  });
}
