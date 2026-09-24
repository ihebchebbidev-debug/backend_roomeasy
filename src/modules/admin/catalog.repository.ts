import { apiError } from "@/core/errors.js";
import { query, queryOne } from "@/db/query.js";

/* ------------------------------------------------------------------ amenities */

export type AmenityRow = { id: string; group: string; label_en: string; label_fr: string; label_es: string; label_de: string; label_pt: string; paid: boolean; active: boolean };

export async function upsertAmenity(input: {
  id: string;
  group: string;
  labelEn: string;
  labelFr: string;
  labelEs?: string;
  labelDe?: string;
  labelPt?: string;
  paid: boolean;
  active: boolean;
}) {
  const row = await queryOne<AmenityRow>(
    `INSERT INTO equipment (id, "group", label_en, label_fr, paid, active, label_es, label_de, label_pt)
     VALUES ($1, $2::equipment_group, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE
        SET "group" = EXCLUDED."group", label_en = EXCLUDED.label_en, label_fr = EXCLUDED.label_fr,
            label_es = EXCLUDED.label_es, label_de = EXCLUDED.label_de, label_pt = EXCLUDED.label_pt,
            paid = EXCLUDED.paid, active = EXCLUDED.active
     RETURNING id, "group"::text AS "group", label_en, label_fr, label_es, label_de, label_pt, paid, active`,
    [input.id, input.group, input.labelEn, input.labelFr, input.paid, input.active, input.labelEs ?? "", input.labelDe ?? "", input.labelPt ?? ""],
    { label: "catalog.amenity.upsert" },
  );
  if (!row) throw apiError("INTERNAL");
  return { id: row.id, group: row.group, label: { en: row.label_en, fr: row.label_fr, es: row.label_es, de: row.label_de, pt: row.label_pt }, paid: row.paid, active: row.active };
}

/** Amenities in use are retired (inactive) instead of deleted so listings keep their data. */
export async function removeAmenity(id: string): Promise<{ deleted: boolean }> {
  const used = await queryOne<{ used: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM property_equipment WHERE equipment_id = $1) AS used`,
    [id],
    { label: "catalog.amenity.used" },
  ).catch(() => ({ used: true }));
  if (used?.used) {
    await query("UPDATE equipment SET active = false WHERE id = $1", [id], { label: "catalog.amenity.retire" });
    return { deleted: false };
  }
  await query("DELETE FROM equipment WHERE id = $1", [id], { label: "catalog.amenity.delete" });
  return { deleted: true };
}

export async function amenityGroups(): Promise<string[]> {
  const rows = await query<{ value: string }>(
    `SELECT unnest(enum_range(NULL::equipment_group))::text AS value`,
    [],
    { label: "catalog.amenity.groups" },
  );
  return rows.map((row) => row.value);
}

/* --------------------------------------------------------------------- cities */

type CityRow = {
  id: string;
  name: string;
  country: string;
  slug: string;
  active: boolean;
  featured: boolean;
  sort_order: number;
  listings: string;
};

function mapCity(row: CityRow) {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    slug: row.slug,
    active: row.active,
    featured: row.featured,
    sortOrder: row.sort_order,
    listings: Number(row.listings ?? 0),
  };
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function listCities(options: { includeInactive: boolean }) {
  const rows = await query<CityRow>(
    `SELECT c.*, (SELECT count(*) FROM property p WHERE lower(p.city) = lower(c.name))::text AS listings
       FROM city c
      ${options.includeInactive ? "" : "WHERE c.active"}
      ORDER BY c.sort_order, c.name`,
    [],
    { label: "catalog.city.list" },
  );
  return rows.map(mapCity);
}

export async function saveCity(input: {
  id?: string;
  name: string;
  country: string;
  active: boolean;
  featured: boolean;
  sortOrder: number;
}) {
  const slug = slugify(`${input.name}-${input.country}`) || slugify(input.name);
  const row = input.id
    ? await queryOne<CityRow>(
        `UPDATE city SET name = $2, country = $3, slug = $4, active = $5, featured = $6, sort_order = $7
          WHERE id = $1
          RETURNING *, '0' AS listings`,
        [input.id, input.name, input.country, slug, input.active, input.featured, input.sortOrder],
        { label: "catalog.city.update" },
      )
    : await queryOne<CityRow>(
        `INSERT INTO city (name, country, slug, active, featured, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *, '0' AS listings`,
        [input.name, input.country, slug, input.active, input.featured, input.sortOrder],
        { label: "catalog.city.insert" },
      );
  if (!row) throw apiError("NOT_FOUND");
  return mapCity(row);
}

export async function deleteCity(id: string) {
  await query("DELETE FROM city WHERE id = $1", [id], { label: "catalog.city.delete" });
}

/** One-click import of every city already used by a listing. */
export async function importCitiesFromListings(): Promise<number> {
  const rows = await query<{ name: string; country: string }>(
    `SELECT DISTINCT ON (lower(city)) city AS name, coalesce(country, '') AS country
       FROM property WHERE coalesce(city, '') <> ''
      ORDER BY lower(city)`,
    [],
    { label: "catalog.city.distinct" },
  );
  let added = 0;
  for (const row of rows) {
    const slug = slugify(`${row.name}-${row.country}`) || slugify(row.name);
    const inserted = await query<{ id: string }>(
      `INSERT INTO city (name, country, slug) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [row.name, row.country, slug],
      { label: "catalog.city.import" },
    );
    added += inserted.length;
  }
  return added;
}

/* ------------------------------------------------------------- content pages */

type PageRow = {
  slug: string;
  locale: string;
  title: string;
  body: string;
  published: boolean;
  updated_at: Date;
  updated_by_name: string | null;
};

function mapPage(row: PageRow) {
  return {
    slug: row.slug,
    locale: row.locale,
    title: row.title,
    body: row.body,
    published: row.published,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by_name,
  };
}

export async function listPages() {
  const rows = await query<PageRow>(
    `SELECT p.*, u.full_name AS updated_by_name
       FROM content_page p LEFT JOIN app_user u ON u.id = p.updated_by
      ORDER BY p.slug, p.locale`,
    [],
    { label: "catalog.page.list" },
  );
  return rows.map(mapPage);
}

/** Public read: the requested locale, falling back to English. */
export async function publicPage(slug: string, locale: string) {
  const row = await queryOne<PageRow>(
    `SELECT p.*, NULL::text AS updated_by_name
       FROM content_page p
      WHERE p.slug = $1 AND p.published AND p.locale IN ($2, 'en')
      ORDER BY (p.locale = $2) DESC
      LIMIT 1`,
    [slug, locale],
    { label: "catalog.page.public" },
  );
  return row ? mapPage(row) : null;
}

export async function savePage(input: {
  slug: string;
  locale: string;
  title: string;
  body: string;
  published: boolean;
  adminId: string;
}) {
  const row = await queryOne<PageRow>(
    `INSERT INTO content_page (slug, locale, title, body, published, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug, locale) DO UPDATE
        SET title = EXCLUDED.title, body = EXCLUDED.body, published = EXCLUDED.published,
            updated_by = EXCLUDED.updated_by
     RETURNING *, NULL::text AS updated_by_name`,
    [input.slug, input.locale, input.title, input.body, input.published, input.adminId],
    { label: "catalog.page.save" },
  );
  if (!row) throw apiError("INTERNAL");
  return mapPage(row);
}

export async function deletePage(slug: string, locale: string) {
  await query("DELETE FROM content_page WHERE slug = $1 AND locale = $2", [slug, locale], {
    label: "catalog.page.delete",
  });
}

/* --------------------------------------------------------------- translations */

export async function listTranslations(locale?: string) {
  const rows = await query<{ locale: string; key: string; value: string; updated_at: Date }>(
    `SELECT locale, key, value, updated_at FROM translation_override
      ${locale ? "WHERE locale = $1" : ""}
      ORDER BY locale, key`,
    locale ? [locale] : [],
    { label: "catalog.translation.list" },
  );
  return rows.map((row) => ({ locale: row.locale, key: row.key, value: row.value, updatedAt: row.updated_at.toISOString() }));
}

export async function saveTranslation(input: { locale: string; key: string; value: string; adminId: string }) {
  await query(
    `INSERT INTO translation_override (locale, key, value, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (locale, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
    [input.locale, input.key, input.value, input.adminId],
    { label: "catalog.translation.save" },
  );
}

export async function deleteTranslation(locale: string, key: string) {
  await query("DELETE FROM translation_override WHERE locale = $1 AND key = $2", [locale, key], {
    label: "catalog.translation.delete",
  });
}

/* ------------------------------------------------------------ boot-time seed */

const DEFAULT_CITIES: Array<[string, string]> = [
  ["Paris", "France"], ["Lyon", "France"], ["Nice", "France"], ["Marseille", "France"], ["Bordeaux", "France"],
  ["London", "United Kingdom"], ["Edinburgh", "United Kingdom"],
  ["Barcelona", "Spain"], ["Madrid", "Spain"], ["Seville", "Spain"], ["Valencia", "Spain"],
  ["Lisbon", "Portugal"], ["Porto", "Portugal"],
  ["Rome", "Italy"], ["Milan", "Italy"], ["Florence", "Italy"], ["Venice", "Italy"],
  ["Berlin", "Germany"], ["Munich", "Germany"], ["Hamburg", "Germany"],
  ["Amsterdam", "Netherlands"], ["Brussels", "Belgium"], ["Vienna", "Austria"],
  ["Zurich", "Switzerland"], ["Geneva", "Switzerland"], ["Prague", "Czechia"],
  ["Athens", "Greece"], ["Dublin", "Ireland"], ["Copenhagen", "Denmark"], ["Stockholm", "Sweden"],
];
const FEATURED = new Set(["Paris", "London", "Barcelona", "Lisbon", "Rome", "Amsterdam", "Berlin", "Nice"]);

const DEFAULT_PAGES: Array<{ slug: string; locale: string; title: string; body: string }> = [
  { slug: "terms", locale: "en", title: "Terms of Service", body: "## 1. About RoomEasy\nRoomEasy connects guests with hosts offering short-stay accommodation.\n\n## 2. Accounts\nYou must provide accurate information and keep your login secure.\n\n## 3. Bookings and payments\nPayments are processed securely by Stripe. The platform commission is shown before you confirm.\n\n## 4. Cancellations\nEach listing shows its cancellation policy; refunds follow that policy.\n\n## 5. Conduct\nListings and messages must be honest and respectful. We may remove content or suspend accounts that break these rules." },
  { slug: "terms", locale: "fr", title: "Conditions d'utilisation", body: "## 1. À propos de RoomEasy\nRoomEasy met en relation voyageurs et hôtes proposant des séjours courts.\n\n## 2. Comptes\nVous devez fournir des informations exactes et protéger votre connexion.\n\n## 3. Réservations et paiements\nLes paiements sont traités par Stripe. La commission est affichée avant confirmation.\n\n## 4. Annulations\nChaque annonce indique sa politique d'annulation ; les remboursements la suivent.\n\n## 5. Comportement\nAnnonces et messages doivent être honnêtes et respectueux. Nous pouvons retirer un contenu ou suspendre un compte." },
  { slug: "privacy", locale: "en", title: "Privacy Policy", body: "## Data we collect\nAccount details, listings, bookings, messages and payment references.\n\n## Why we use it\nTo run bookings, process payments, prevent fraud and provide support.\n\n## Sharing\nGuests and hosts see what is needed for a stay. Card data is handled only by Stripe.\n\n## Your rights\nYou can access, correct or delete your data by contacting support." },
  { slug: "privacy", locale: "fr", title: "Politique de confidentialité", body: "## Données collectées\nInformations de compte, annonces, réservations, messages et références de paiement.\n\n## Utilisation\nGérer les réservations, traiter les paiements, prévenir la fraude et assurer le support.\n\n## Partage\nVoyageurs et hôtes voient ce qui est nécessaire au séjour. Les données de carte sont traitées uniquement par Stripe.\n\n## Vos droits\nVous pouvez consulter, corriger ou supprimer vos données en contactant le support." },
  { slug: "help", locale: "en", title: "Help Center", body: "## How do I book?\nPick your dates, check the price breakdown and pay securely.\n\n## How do I become a host?\nCreate a listing from your account; it goes live after review.\n\n## How do I cancel?\nOpen the booking in your account and choose Cancel. Refunds follow the listing's policy.\n\n## Need more help?\nOpen a support ticket from your account." },
  { slug: "help", locale: "fr", title: "Centre d'aide", body: "## Comment réserver ?\nChoisissez vos dates, vérifiez le détail du prix et payez en toute sécurité.\n\n## Comment devenir hôte ?\nCréez une annonce depuis votre compte ; elle est publiée après vérification.\n\n## Comment annuler ?\nOuvrez la réservation dans votre compte et choisissez Annuler.\n\n## Besoin d'aide ?\nOuvrez un ticket depuis votre compte." },
];

/** Inserts default cities and pages once (only when empty); admin edits are never overwritten. */
export async function seedCatalog(): Promise<{ cities: number; pages: number }> {
  let cities = 0;
  let pages = 0;
  const cityCount = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM city", [], { label: "catalog.seed.cityCount" });
  if (Number(cityCount?.n ?? 0) === 0) {
    for (const [i, [name, country]] of DEFAULT_CITIES.entries()) {
      const rows = await query<{ id: string }>(
        `INSERT INTO city (name, country, slug, active, featured, sort_order)
         VALUES ($1, $2, $3, true, $4, $5) ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [name, country, slugify(`${name}-${country}`), FEATURED.has(name), i],
        { label: "catalog.seed.city" },
      );
      cities += rows.length;
    }
  }
  for (const p of DEFAULT_PAGES) {
    const rows = await query<{ slug: string }>(
      `INSERT INTO content_page (slug, locale, title, body, published)
       VALUES ($1, $2, $3, $4, true) ON CONFLICT (slug, locale) DO NOTHING RETURNING slug`,
      [p.slug, p.locale, p.title, p.body],
      { label: "catalog.seed.page" },
    );
    pages += rows.length;
  }
  return { cities, pages };
}
