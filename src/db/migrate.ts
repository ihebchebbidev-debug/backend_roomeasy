import type { PoolClient } from "pg";

import { apiError } from "@/core/errors.js";
import { log } from "@/core/logger.js";
import { withClient } from "@/db/pool.js";
import { schemaDefinition } from "@/db/registry/index.js";
import type { ColumnDef, IndexDef, TableDef } from "@/db/registry/types.js";

const logger = log("db.migrate");

/**
 * Schema reconciler.
 *
 * It compares the live database against `src/db/registry/*` and applies only
 * what is missing:
 *
 *   extensions → enum types & values → helper functions → tables → columns →
 *   foreign keys → table constraints → indexes → touch triggers → views →
 *   finalisers (triggers, default rows)
 *
 * Every step is idempotent, so it is safe to run on every boot, and safe to
 * run again mid-request when a query hits an object that does not exist yet.
 */

export type MigrationReport = {
  applied: string[];
  durationMs: number;
  trigger: string;
};

function quoteIdent(name: string): string {
  return name.startsWith('"') ? name : `"${name}"`;
}

/** Column name as written in the registry, stripped of its quotes. */
function plainName(column: ColumnDef): string {
  return column.name.replace(/"/g, "");
}

function columnDdl(column: ColumnDef, options: { forAlter: boolean }): string {
  const parts = [quoteIdent(plainName(column)), column.type];
  if (column.generated) {
    parts.push(`GENERATED ALWAYS AS (${column.generated}) STORED`);
    return parts.join(" ");
  }
  if (column.default !== undefined) parts.push(`DEFAULT ${column.default}`);
  // A NOT NULL column can only be bolted onto an existing table when it has a
  // default; otherwise it is added nullable and reported.
  if (column.notNull && (!options.forAlter || column.default !== undefined)) parts.push("NOT NULL");
  if (column.check) parts.push(`CHECK (${column.check})`);
  return parts.join(" ");
}

async function exec(client: PoolClient, sql: string, applied: string[], label: string): Promise<boolean> {
  try {
    await client.query(sql);
    applied.push(label);
    logger.info({ step: label }, "schema change applied");
    return true;
  } catch (error) {
    logger.error({ step: label, sql: sql.slice(0, 400), err: error }, "schema change failed");
    throw error;
  }
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = current_schema() AND table_name = $1) AS exists`,
    [table],
  );
  return rows[0]?.exists === true;
}

async function existingColumns(client: PoolClient, table: string): Promise<Set<string>> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

async function constraintExists(client: PoolClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists === true;
}

async function indexExists(client: PoolClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists === true;
}

async function triggerExists(client: PoolClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = $1) AS exists`,
    [name],
  );
  return rows[0]?.exists === true;
}

async function ensureExtensions(client: PoolClient, applied: string[]) {
  for (const extension of schemaDefinition.extensions) {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS exists`,
      [extension],
    );
    if (rows[0]?.exists) continue;
    await exec(client, `CREATE EXTENSION IF NOT EXISTS ${extension}`, applied, `extension:${extension}`);
  }
}

async function ensureEnums(client: PoolClient, applied: string[]) {
  for (const definition of schemaDefinition.enums) {
    const { rows: typeRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = $1) AS exists`,
      [definition.name],
    );

    if (!typeRows[0]?.exists) {
      const values = definition.values.map((value) => `'${value}'`).join(", ");
      await exec(client, `CREATE TYPE ${definition.name} AS ENUM (${values})`, applied, `enum:${definition.name}`);
      continue;
    }

    const { rows: valueRows } = await client.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1`,
      [definition.name],
    );
    const present = new Set(valueRows.map((row) => row.enumlabel));
    for (const value of definition.values) {
      if (present.has(value)) continue;
      // ADD VALUE IF NOT EXISTS is autocommitted; it must not run inside a tx.
      await exec(
        client,
        `ALTER TYPE ${definition.name} ADD VALUE IF NOT EXISTS '${value}'`,
        applied,
        `enum-value:${definition.name}.${value}`,
      );
    }
  }
}

/**
 * Functions are installed twice: a tolerant first pass, because a generated
 * column may need one while creating its table, and a strict second pass once
 * every table exists, for the functions that read from them.
 */
async function ensureFunctions(client: PoolClient, applied: string[], options: { tolerant?: boolean } = {}) {
  for (const [index, sql] of schemaDefinition.functions.entries()) {
    const name = /FUNCTION\s+(\w+)/i.exec(sql)?.[1] ?? `fn-${index}`;
    if (!options.tolerant) {
      await exec(client, sql, applied, `function:${name}`);
      continue;
    }
    try {
      await exec(client, sql, applied, `function:${name}`);
    } catch {
      // The tables it reads are not there yet; the strict pass will install it.
      logger.debug({ function: name }, "function deferred until the tables exist");
    }
  }
}

async function ensureTable(client: PoolClient, table: TableDef, applied: string[]) {
  if (!(await tableExists(client, table.name))) {
    const columns = table.columns.map((column) => columnDdl(column, { forAlter: false }));
    if (table.primaryKey?.length) {
      columns.push(`PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(", ")})`);
    }
    await exec(client, `CREATE TABLE ${quoteIdent(table.name)} (\n  ${columns.join(",\n  ")}\n)`, applied, `table:${table.name}`);
    if (table.comment) {
      await client.query(`COMMENT ON TABLE ${quoteIdent(table.name)} IS $1`, [table.comment]).catch(() => undefined);
    }
    return;
  }

  // Table exists: add whatever column the registry gained since it was created.
  const present = await existingColumns(client, table.name);
  for (const column of table.columns) {
    const name = plainName(column);
    if (present.has(name)) continue;
    if (column.notNull && column.default === undefined && !column.generated) {
      logger.warn(
        { table: table.name, column: name },
        "column added as NULLable: it is declared NOT NULL but has no default, so existing rows cannot be filled",
      );
    }
    await exec(
      client,
      `ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN IF NOT EXISTS ${columnDdl(column, { forAlter: true })}`,
      applied,
      `column:${table.name}.${name}`,
    );
  }
}

async function ensureColumnExtras(client: PoolClient, table: TableDef, applied: string[]) {
  for (const column of table.columns) {
    const name = plainName(column);
    if (column.unique) {
      const constraint = `${table.name}_${name}_key`;
      if (!(await constraintExists(client, constraint))) {
        await exec(
          client,
          `ALTER TABLE ${quoteIdent(table.name)} ADD CONSTRAINT ${quoteIdent(constraint)} UNIQUE (${quoteIdent(name)})`,
          applied,
          `unique:${constraint}`,
        );
      }
    }
    if (column.references) {
      const constraint = `${table.name}_${name}_fkey`;
      if (!(await constraintExists(client, constraint))) {
        await exec(
          client,
          `ALTER TABLE ${quoteIdent(table.name)} ADD CONSTRAINT ${quoteIdent(constraint)}
             FOREIGN KEY (${quoteIdent(name)}) REFERENCES ${column.references}`,
          applied,
          `fkey:${constraint}`,
        );
      }
    }
  }
}

async function ensureConstraints(client: PoolClient, table: TableDef, applied: string[]) {
  for (const constraint of table.constraints ?? []) {
    if (await constraintExists(client, constraint.name)) continue;
    await exec(
      client,
      `ALTER TABLE ${quoteIdent(table.name)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${constraint.definition}`,
      applied,
      `constraint:${constraint.name}`,
    );
  }
}

async function ensureIndexes(client: PoolClient, table: TableDef, applied: string[]) {
  for (const index of (table.indexes ?? []) as IndexDef[]) {
    if (await indexExists(client, index.name)) continue;
    const unique = index.unique ? "UNIQUE " : "";
    const using = index.using ? ` USING ${index.using}` : "";
    const where = index.where ? ` WHERE ${index.where}` : "";
    await exec(
      client,
      `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(table.name)}${using} (${index.on})${where}`,
      applied,
      `index:${index.name}`,
    );
  }
}

async function ensureTouchTrigger(client: PoolClient, table: TableDef, applied: string[]) {
  if (!table.touchUpdatedAt) return;
  const name = `${table.name}_touch`;
  if (await triggerExists(client, name)) return;
  await exec(
    client,
    `CREATE TRIGGER ${quoteIdent(name)} BEFORE UPDATE ON ${quoteIdent(table.name)}
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    applied,
    `trigger:${name}`,
  );
}

async function ensureViews(client: PoolClient, applied: string[]) {
  for (const view of schemaDefinition.views) {
    await exec(client, `CREATE OR REPLACE VIEW ${quoteIdent(view.name)} AS ${view.definition}`, applied, `view:${view.name}`);
  }
}

async function ensureFinalisers(client: PoolClient, applied: string[]) {
  for (const [index, sql] of schemaDefinition.finalisers.entries()) {
    await exec(client, sql, applied, `finaliser:${index + 1}`);
  }
}

async function recordRun(
  client: PoolClient,
  report: { trigger: string; applied: string[]; durationMs: number; error?: unknown },
) {
  try {
    await client.query(
      `INSERT INTO schema_migration_log (trigger_source, statements, applied, duration_ms, succeeded, error_message)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        report.trigger,
        report.applied.length,
        JSON.stringify(report.applied),
        Math.round(report.durationMs),
        !report.error,
        report.error instanceof Error ? report.error.message : report.error ? String(report.error) : null,
      ],
    );
  } catch (error) {
    logger.warn({ err: error }, "could not write the migration log row");
  }
}

let running: Promise<MigrationReport> | null = null;

/** Brings the live database in line with the registry. Safe to call anytime. */
export async function reconcileSchema(options: { trigger?: string } = {}): Promise<MigrationReport> {
  if (running) return running;
  const trigger = options.trigger ?? "manual";

  running = withClient(async (client) => {
    const applied: string[] = [];
    const startedAt = Date.now();
    logger.info({ trigger }, "schema reconciliation started");

    try {
      await ensureExtensions(client, applied);
      await ensureEnums(client, applied);
      await ensureFunctions(client, applied, { tolerant: true });

      for (const table of schemaDefinition.tables) {
        await ensureTable(client, table, applied);
      }
      // Now that every table exists, install the functions that query them.
      await ensureFunctions(client, applied);
      for (const table of schemaDefinition.tables) {
        await ensureColumnExtras(client, table, applied);
        await ensureConstraints(client, table, applied);
        await ensureIndexes(client, table, applied);
        await ensureTouchTrigger(client, table, applied);
      }

      await ensureViews(client, applied);
      await ensureFinalisers(client, applied);

      const durationMs = Date.now() - startedAt;
      await recordRun(client, { trigger, applied, durationMs });
      logger.info(
        { trigger, changes: applied.length, durationMs },
        applied.length ? "schema reconciliation applied changes" : "schema already up to date",
      );
      return { applied, durationMs, trigger };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await recordRun(client, { trigger, applied, durationMs, error });
      logger.fatal({ trigger, err: error, applied }, "schema reconciliation failed");
      throw apiError("SCHEMA_REPAIR_FAILED", {
        message: "The database schema could not be brought up to date. See the server logs for the failing statement.",
        details: { trigger, appliedBeforeFailure: applied.length },
        cause: error,
      });
    }
  }).finally(() => {
    running = null;
  });

  return running;
}
