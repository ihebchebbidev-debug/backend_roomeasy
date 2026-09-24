import { apiError } from "@/core/errors.js";
import { query } from "@/db/query.js";

export type EquipmentDto = {
  id: string;
  group: string;
  label: { en: string; fr: string; es: string; de: string; pt: string };
  paid: boolean;
  active: boolean;
};

type EquipmentRow = { id: string; group: string; label_en: string; label_fr: string; label_es: string; label_de: string; label_pt: string; paid: boolean; active: boolean };

function mapEquipment(row: EquipmentRow): EquipmentDto {
  return {
    id: row.id,
    group: row.group,
    label: { en: row.label_en, fr: row.label_fr, es: row.label_es || row.label_en, de: row.label_de || row.label_en, pt: row.label_pt || row.label_en },
    paid: row.paid,
    active: row.active,
  };
}

/** The 195-item equipment & services catalogue used by the host picker. */
export async function listEquipment(options: {
  group?: string;
  search?: string;
  includeInactive?: boolean;
}): Promise<EquipmentDto[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (!options.includeInactive) clauses.push("active = true");
  if (options.group && options.group !== "all") {
    values.push(options.group);
    clauses.push(`"group" = $${values.length}::equipment_group`);
  }
  if (options.search?.trim()) {
    values.push(options.search.trim());
    clauses.push(`(label_en ILIKE '%' || $${values.length} || '%' OR label_fr ILIKE '%' || $${values.length} || '%')`);
  }

  const rows = await query<EquipmentRow>(
    `SELECT id, "group"::text AS "group", label_en, label_fr, label_es, label_de, label_pt, paid, active
       FROM equipment
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY "group", label_en`,
    values,
    { label: "equipment.list" },
  );

  return rows.map(mapEquipment);
}

export async function countEquipmentByGroup(): Promise<Record<string, number>> {
  const rows = await query<{ group: string; total: string }>(
    `SELECT "group"::text AS "group", count(*)::text AS total FROM equipment WHERE active = true GROUP BY "group" ORDER BY 1`,
    [],
    { label: "equipment.countByGroup" },
  );
  const counts: Record<string, number> = { all: 0 };
  for (const row of rows) {
    counts[row.group] = Number(row.total);
    counts["all"] = (counts["all"] ?? 0) + Number(row.total);
  }
  return counts;
}

/**
 * Rejects a listing save that references an equipment id which is not in the
 * catalogue, naming the offending ids instead of failing on a foreign key.
 */
export async function assertEquipmentExists(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await query<{ id: string }>(
    `SELECT id FROM equipment WHERE id = ANY($1::text[]) AND active = true`,
    [ids],
    { label: "equipment.assertExists" },
  );
  const known = new Set(rows.map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw apiError("UNKNOWN_EQUIPMENT", {
      message: `These equipment items do not exist in the catalogue: ${unknown.join(", ")}.`,
      details: { unknown },
      issues: unknown.map((id) => ({ field: `equipment.${id}`, message: "Unknown equipment id." })),
    });
  }
}
