import { apiError } from "@/core/errors.js";
import { query, queryOne } from "@/db/query.js";

/* ------------------------------------------------------------- property types */

type TypeRow = {
  id: string;
  label_en: string;
  label_fr: string;
  label_es: string;
  label_de: string;
  label_pt: string;
  active: boolean;
  sort_order: number;
  listings?: string;
};

export type PropertyTypeInput = {
  id: string;
  labels: { en: string; fr: string; es: string; de: string; pt: string };
  active: boolean;
  sortOrder: number;
};

function mapType(row: TypeRow) {
  return {
    id: row.id,
    labels: { en: row.label_en, fr: row.label_fr, es: row.label_es, de: row.label_de, pt: row.label_pt },
    active: row.active,
    sortOrder: row.sort_order,
    listings: Number(row.listings ?? 0),
  };
}

export async function listPropertyTypes(options: { includeInactive: boolean }) {
  const rows = await query<TypeRow>(
    `SELECT t.*, (SELECT count(*) FROM property p WHERE p.category::text = t.id)::text AS listings
       FROM property_type t
      ${options.includeInactive ? "" : "WHERE t.active"}
      ORDER BY t.sort_order, t.label_en`,
    [],
    { label: "taxonomy.type.list" },
  );
  return rows.map(mapType);
}

/** True when the id is an active property type a host may publish with. */
export async function isActivePropertyType(id: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    "SELECT true AS ok FROM property_type WHERE id = $1 AND active",
    [id],
    { label: "taxonomy.type.check" },
  );
  return Boolean(row?.ok);
}

export async function savePropertyType(input: PropertyTypeInput) {
  // Listings store the type in a database enum: a brand-new type is added to it first.
  // ADD VALUE cannot take a bind parameter; the id is validated to [a-z0-9_-] beforehand.
  if (!/^[a-z0-9_-]{2,40}$/.test(input.id)) throw apiError("VALIDATION_FAILED", { message: "Invalid type code." });
  await query(`ALTER TYPE property_category ADD VALUE IF NOT EXISTS '${input.id}'`, [], { label: "taxonomy.type.enum" });
  const row = await queryOne<TypeRow>(
    `INSERT INTO property_type (id, label_en, label_fr, label_es, label_de, label_pt, active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       label_en = EXCLUDED.label_en, label_fr = EXCLUDED.label_fr, label_es = EXCLUDED.label_es,
       label_de = EXCLUDED.label_de, label_pt = EXCLUDED.label_pt,
       active = EXCLUDED.active, sort_order = EXCLUDED.sort_order
     RETURNING *, '0' AS listings`,
    [
      input.id,
      input.labels.en,
      input.labels.fr,
      input.labels.es,
      input.labels.de,
      input.labels.pt,
      input.active,
      input.sortOrder,
    ],
    { label: "taxonomy.type.save" },
  );
  if (!row) throw apiError("INTERNAL");
  return mapType(row);
}

/**
 * Deletes an unused type. A type used by listings is switched off instead, so
 * existing listings keep working. (Postgres cannot drop enum values; an unused
 * value simply stays dormant.)
 */
export async function removePropertyType(id: string): Promise<{ deleted: boolean }> {
  const used = await queryOne<{ n: string }>(
    "SELECT count(*)::text AS n FROM property WHERE category::text = $1",
    [id],
    { label: "taxonomy.type.used" },
  );
  if (Number(used?.n ?? 0) > 0) {
    await query("UPDATE property_type SET active = false WHERE id = $1", [id], { label: "taxonomy.type.retire" });
    return { deleted: false };
  }
  await query("DELETE FROM property_type WHERE id = $1", [id], { label: "taxonomy.type.delete" });
  return { deleted: true };
}

/* ------------------------------------------------------------------ countries */

type CountryRow = { code: string; name: string; active: boolean; sort_order: number; listings?: string };

function mapCountry(row: CountryRow) {
  return { code: row.code, name: row.name, active: row.active, sortOrder: row.sort_order, listings: Number(row.listings ?? 0) };
}

export async function listCountries(options: { includeInactive: boolean }) {
  const rows = await query<CountryRow>(
    `SELECT c.*, (SELECT count(*) FROM property p WHERE lower(p.country) = lower(c.name))::text AS listings
       FROM country c
      ${options.includeInactive ? "" : "WHERE c.active"}
      ORDER BY c.sort_order, c.name`,
    [],
    { label: "taxonomy.country.list" },
  );
  return rows.map(mapCountry);
}

export async function saveCountry(input: { code: string; name: string; active: boolean; sortOrder: number }) {
  const row = await queryOne<CountryRow>(
    `INSERT INTO country (code, name, active, sort_order) VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order
     RETURNING *, '0' AS listings`,
    [input.code, input.name, input.active, input.sortOrder],
    { label: "taxonomy.country.save" },
  );
  if (!row) throw apiError("INTERNAL");
  return mapCountry(row);
}

export async function deleteCountry(code: string) {
  await query("DELETE FROM country WHERE code = $1", [code], { label: "taxonomy.country.delete" });
}

/* ------------------------------------------------------------ boot-time seed */

const DEFAULT_TYPES: [string, string, string, string, string, string][] = [
  ["apartment", "Apartment", "Appartement", "Apartamento", "Wohnung", "Apartamento"],
  ["villa", "Villa", "Villa", "Villa", "Villa", "Moradia"],
  ["resort", "Resort", "Resort", "Resort", "Resort", "Resort"],
  ["hotel", "Hotel", "Hôtel", "Hotel", "Hotel", "Hotel"],
  ["lodge", "Lodge", "Lodge", "Lodge", "Lodge", "Lodge"],
  ["guesthouse", "Guesthouse", "Maison d'hôtes", "Casa de huéspedes", "Gästehaus", "Casa de hóspedes"],
  ["riad", "Riad", "Riad", "Riad", "Riad", "Riad"],
  ["studio", "Studio", "Studio", "Estudio", "Studio", "Estúdio"],
  ["bungalow", "Bungalow", "Bungalow", "Bungalow", "Bungalow", "Bungalow"],
  ["chalet", "Chalet", "Chalet", "Chalet", "Chalet", "Chalé"],
  ["hostel", "Hostel", "Auberge", "Albergue", "Hostel", "Hostel"],
  ["camping", "Camping", "Camping", "Camping", "Camping", "Campismo"],
];

/** Every European country, matching the list hosts could pick from before. */
const DEFAULT_COUNTRIES: [string, string][] = [
  ["AL", "Albania"], ["AD", "Andorra"], ["AT", "Austria"], ["BY", "Belarus"], ["BE", "Belgium"],
  ["BA", "Bosnia & Herzegovina"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czechia"],
  ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"],
  ["GR", "Greece"], ["HU", "Hungary"], ["IS", "Iceland"], ["IE", "Ireland"], ["IT", "Italy"],
  ["XK", "Kosovo"], ["LV", "Latvia"], ["LI", "Liechtenstein"], ["LT", "Lithuania"], ["LU", "Luxembourg"],
  ["MT", "Malta"], ["MD", "Moldova"], ["MC", "Monaco"], ["ME", "Montenegro"], ["NL", "Netherlands"],
  ["MK", "North Macedonia"], ["NO", "Norway"], ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"],
  ["RU", "Russia"], ["SM", "San Marino"], ["RS", "Serbia"], ["SK", "Slovakia"], ["SI", "Slovenia"],
  ["ES", "Spain"], ["SE", "Sweden"], ["CH", "Switzerland"], ["UA", "Ukraine"], ["GB", "United Kingdom"],
  ["VA", "Vatican City"],
];

/**
 * Inserts the default property types and countries the first time only
 * (ON CONFLICT DO NOTHING), so admin edits are never overwritten on restart.
 */
export async function seedTaxonomy(): Promise<{ types: number; countries: number }> {
  let types = 0;
  for (const [index, [id, en, fr, es, de, pt]] of DEFAULT_TYPES.entries()) {
    const rows = await query(
      `INSERT INTO property_type (id, label_en, label_fr, label_es, label_de, label_pt, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, en, fr, es, de, pt, index],
      { label: "taxonomy.seed.type" },
    );
    types += rows.length;
  }
  const existing = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM country", [], { label: "taxonomy.seed.count" });
  let countries = 0;
  if (Number(existing?.n ?? 0) === 0) {
    for (const [code, name] of DEFAULT_COUNTRIES) {
      await query("INSERT INTO country (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING", [code, name], {
        label: "taxonomy.seed.country",
      });
      countries += 1;
    }
  }
  return { types, countries };
}
