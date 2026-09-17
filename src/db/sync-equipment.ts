import { query } from "@/db/query.js";
import { EQUIPMENT_SEED } from "@/db/seed-data.js";

/**
 * Upserts the amenity catalogue the listing form validates against.
 * Idempotent, so it is safe to run on every boot.
 */
export async function syncEquipmentCatalogue(): Promise<number> {
  for (const item of EQUIPMENT_SEED) {
    await query(
      `INSERT INTO equipment (id, "group", label_en, label_fr, paid, active)
       VALUES ($1, $2::equipment_group, $3, $4, $5, true)
       ON CONFLICT (id) DO UPDATE
         SET "group" = EXCLUDED."group",
             label_en = EXCLUDED.label_en,
             label_fr = EXCLUDED.label_fr,
             paid = EXCLUDED.paid,
             active = true`,
      [item.id, item.group, item.labelEn, item.labelFr, item.paid ?? false],
      { label: "equipment.sync" },
    );
  }
  return EQUIPMENT_SEED.length;
}
