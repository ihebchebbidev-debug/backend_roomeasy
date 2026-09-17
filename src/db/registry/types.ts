/**
 * Declarative description of the database, used by the auto-migrator.
 *
 * `db/schema.sql` in the repository root is the human reference; this registry
 * is the machine-readable version the server reconciles against on every boot
 * (and on the fly when a request hits a column that does not exist yet).
 */

export type ColumnDef = {
  name: string;
  /** Full SQL type, e.g. `text`, `numeric(12,2)`, `booking_status`. */
  type: string;
  notNull?: boolean;
  /** SQL literal or expression, e.g. `now()`, `'draft'`, `0`. */
  default?: string;
  /** Column-level CHECK expression without the CHECK keyword. */
  check?: string;
  /** `table(column) ON DELETE ...` — written verbatim after REFERENCES. */
  references?: string;
  /** GENERATED ALWAYS AS (...) STORED expression. */
  generated?: string;
  unique?: boolean;
  /** Why this column exists when it is not in db/schema.sql. */
  note?: string;
};

export type IndexDef = {
  name: string;
  /** Columns or expression, e.g. `lower(city)` or `property_id, check_in`. */
  on: string;
  unique?: boolean;
  using?: string;
  where?: string;
};

export type ConstraintDef = {
  name: string;
  /** Full constraint body, e.g. `CHECK (check_out > check_in)`. */
  definition: string;
};

export type TableDef = {
  name: string;
  columns: ColumnDef[];
  primaryKey?: string[];
  constraints?: ConstraintDef[];
  indexes?: IndexDef[];
  /** Attach the shared `set_updated_at()` BEFORE UPDATE trigger. */
  touchUpdatedAt?: boolean;
  comment?: string;
};

export type EnumDef = { name: string; values: string[] };

export type ViewDef = { name: string; definition: string };

export type SchemaDefinition = {
  extensions: string[];
  enums: EnumDef[];
  functions: string[];
  tables: TableDef[];
  views: ViewDef[];
  /** Statements applied after tables & views (triggers, backfills). */
  finalisers: string[];
};
