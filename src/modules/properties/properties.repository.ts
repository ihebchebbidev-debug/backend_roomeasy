import { query, queryOne } from "@/db/query.js";

/** Shape returned to the app; mirrors `src/models/property.ts :: Property`. */
export type PropertyDto = {
  id: string;
  name: string;
  location: { en: string; city: string; country: string };
  category: string;
  summary: string | null;
  description: string | null;
  neighbourhood: string | null;
  postal: string | null;
  coords: { lat: number; lng: number } | null;
  guests: number;
  rooms: number;
  beds: number;
  baths: number;
  area: number;
  price: number;
  cleaningFee: number;
  minNights: number;
  cancellationPolicy: string;
  houseRules: string | null;
  checkIn: string | null;
  checkOut: string | null;
  instantBook: boolean;
  rating: number;
  reviewCount: number;
  amenities: string[];
  equipment: string[];
  tags: string[];
  image: string | null;
  gallery: string[];
  host: { id: string | null; name: string | null; avatarUrl: string | null; since: number | null; superhost: boolean } | null;
  listing: {
    id: string;
    status: string;
    approved: boolean;
    nightlyUsd: number;
    longStay: { enabled: boolean; threshold: number; discount: number };
    mobile: { enabled: boolean; discount: number };
  } | null;
  createdAt: string;
  updatedAt: string;
};

type PropertyRow = {
  id: string;
  name: string;
  category: string;
  summary: string | null;
  description: string | null;
  city: string;
  country: string;
  neighbourhood: string | null;
  postal_code: string | null;
  latitude: string | null;
  longitude: string | null;
  guests: number;
  rooms: number;
  beds: number;
  baths: number;
  area_sqm: number;
  base_price_usd: string;
  cleaning_fee_usd: string;
  min_nights: number;
  cancellation_policy: string;
  house_rules: string | null;
  check_in: string | null;
  check_out: string | null;
  instant_book: boolean;
  rating: string;
  review_count: number;
  amenities: string[] | null;
  equipment: string[] | null;
  tags: string[] | null;
  photos: string[] | null;
  host_id: string | null;
  host_name: string | null;
  host_avatar: string | null;
  hosting_since: number | null;
  host_superhost: boolean | null;
  listing_id: string | null;
  listing_status: string | null;
  listing_approved: boolean | null;
  nightly_usd: string | null;
  long_stay_enabled: boolean | null;
  long_stay_threshold: number | null;
  long_stay_discount: string | null;
  mobile_enabled: boolean | null;
  mobile_discount: string | null;
  location_label: string | null;
  created_at: Date;
  updated_at: Date;
  total_count?: string;
};

export function mapProperty(row: PropertyRow): PropertyDto {
  const place = row.location_label ?? [row.city, row.country].filter(Boolean).join(", ");
  const photos = (row.photos ?? []).filter(Boolean);
  return {
    id: row.id,
    name: row.name,
    location: { en: place, city: row.city, country: row.country },
    category: row.category,
    summary: row.summary,
    description: row.description,
    neighbourhood: row.neighbourhood,
    postal: row.postal_code,
    coords:
      row.latitude !== null && row.longitude !== null
        ? { lat: Number(row.latitude), lng: Number(row.longitude) }
        : null,
    guests: row.guests,
    rooms: row.rooms,
    beds: row.beds,
    baths: row.baths,
    area: row.area_sqm,
    price: Number(row.nightly_usd ?? row.base_price_usd),
    cleaningFee: Number(row.cleaning_fee_usd),
    minNights: row.min_nights,
    cancellationPolicy: row.cancellation_policy,
    houseRules: row.house_rules,
    checkIn: row.check_in ? row.check_in.slice(0, 5) : null,
    checkOut: row.check_out ? row.check_out.slice(0, 5) : null,
    instantBook: row.instant_book,
    rating: Number(row.rating),
    reviewCount: row.review_count,
    amenities: row.amenities ?? [],
    equipment: row.equipment ?? [],
    tags: row.tags ?? [],
    image: photos[0] ?? null,
    gallery: photos.slice(1),
    host: row.host_id
      ? {
          id: row.host_id,
          name: row.host_name,
           avatarUrl: row.host_avatar,
          since: row.hosting_since,
          superhost: row.host_superhost === true,
        }
      : null,
    listing: row.listing_id
      ? {
          id: row.listing_id,
          status: row.listing_status as string,
          approved: row.listing_approved === true,
          nightlyUsd: Number(row.nightly_usd ?? row.base_price_usd),
          longStay: {
            enabled: row.long_stay_enabled === true,
            threshold: row.long_stay_threshold ?? 7,
            discount: Number(row.long_stay_discount ?? 0),
          },
          mobile: { enabled: row.mobile_enabled === true, discount: Number(row.mobile_discount ?? 0) },
        }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Shared SELECT list: aggregates photos, amenities, equipment and tags. */
const selectProperty = (localeParam: string) => `
  SELECT p.*,
         h.display_name AS host_name,
          hu.avatar_url AS host_avatar,
         h.hosting_since,
         h.superhost   AS host_superhost,
         l.id      AS listing_id,
         l.status  AS listing_status,
         l.approved AS listing_approved,
         l.nightly_usd, l.long_stay_enabled, l.long_stay_threshold, l.long_stay_discount,
         l.mobile_enabled, l.mobile_discount,
         t.location_label,
         (SELECT array_agg(url ORDER BY position) FROM property_photo WHERE property_id = p.id) AS photos,
         (SELECT array_agg(amenity::text ORDER BY amenity) FROM property_amenity WHERE property_id = p.id) AS amenities,
         (SELECT array_agg(equipment_id ORDER BY equipment_id) FROM property_equipment WHERE property_id = p.id) AS equipment,
         (SELECT array_agg(tag ORDER BY tag) FROM property_tag WHERE property_id = p.id) AS tags
    FROM property p
    LEFT JOIN host_profile h ON h.user_id = p.host_id
    LEFT JOIN app_user hu ON hu.id = p.host_id
    LEFT JOIN listing l ON l.property_id = p.id
    LEFT JOIN property_translation t ON t.property_id = p.id AND t.locale = ${localeParam}
`;

export type SearchFilters = {
  where?: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  rating?: number;
  beds?: number;
  baths?: number;
  rooms?: number;
  guests?: number;
  amenities?: string[];
  equipment?: string[];
  superhost?: boolean;
  from?: string;
  to?: string;
  sort?: "recommended" | "price-low" | "price-high" | "rating" | "distance" | "newest";
  lat?: number;
  lng?: number;
  limit: number;
  offset: number;
  locale?: string;
  /** Admin/host listing views can ask for unpublished rows. */
  includeUnpublished?: boolean;
  hostId?: string;
};

type Where = { clauses: string[]; values: unknown[] };

function buildWhere(filters: SearchFilters, startIndex: number): Where {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: (index: number) => string, value: unknown) => {
    values.push(value);
    clauses.push(clause(startIndex + values.length - 1));
  };

  if (!filters.includeUnpublished) {
    clauses.push(`l.status = 'published'`, `l.approved = true`);
  }
  if (filters.hostId) add((i) => `p.host_id = $${i}`, filters.hostId);
  if (filters.where?.trim()) {
    add(
      (i) =>
        `(deaccent(p.name) LIKE '%' || deaccent($${i}) || '%'
          OR deaccent(p.city) LIKE '%' || deaccent($${i}) || '%'
          OR deaccent(p.country) LIKE '%' || deaccent($${i}) || '%'
          OR deaccent(coalesce(p.neighbourhood, '')) LIKE '%' || deaccent($${i}) || '%'
          OR coalesce(p.postal_code, '') ILIKE '%' || $${i} || '%')`,
      filters.where.trim(),
    );
  }
  if (filters.category && filters.category !== "all") add((i) => `p.category = $${i}::property_category`, filters.category);
  if (filters.minPrice !== undefined) add((i) => `coalesce(l.nightly_usd, p.base_price_usd) >= $${i}`, filters.minPrice);
  if (filters.maxPrice !== undefined) add((i) => `coalesce(l.nightly_usd, p.base_price_usd) <= $${i}`, filters.maxPrice);
  if (filters.rating !== undefined && filters.rating > 0) add((i) => `p.rating >= $${i}`, filters.rating);
  if (filters.beds) add((i) => `p.beds >= $${i}`, filters.beds);
  if (filters.baths) add((i) => `p.baths >= $${i}`, filters.baths);
  if (filters.rooms) add((i) => `p.rooms >= $${i}`, filters.rooms);
  if (filters.guests) add((i) => `p.guests >= $${i}`, filters.guests);
  if (filters.superhost) clauses.push(`coalesce(h.superhost, p.superhost) = true`);

  if (filters.amenities?.length) {
    add(
      (i) => `NOT EXISTS (
        SELECT 1 FROM unnest($${i}::text[]) AS wanted(amenity)
         WHERE NOT EXISTS (
           SELECT 1 FROM property_amenity pa
            WHERE pa.property_id = p.id AND pa.amenity::text = wanted.amenity))`,
      filters.amenities,
    );
  }
  if (filters.equipment?.length) {
    add(
      (i) => `NOT EXISTS (
        SELECT 1 FROM unnest($${i}::text[]) AS wanted(equipment_id)
         WHERE NOT EXISTS (
           SELECT 1 FROM property_equipment pe
            WHERE pe.property_id = p.id AND pe.equipment_id = wanted.equipment_id))`,
      filters.equipment,
    );
  }

  // Free for the requested nights: no blocked night and no live booking.
  if (filters.from && filters.to) {
    values.push(filters.from, filters.to);
    const fromIndex = startIndex + values.length - 2;
    const toIndex = startIndex + values.length - 1;
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM calendar_night cn
       WHERE cn.property_id = p.id AND cn.blocked = true
         AND cn.night >= $${fromIndex}::date AND cn.night < $${toIndex}::date)`);
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM booking b
       WHERE b.property_id = p.id
         AND b.status IN ('pending', 'confirmed', 'completed')
         AND daterange(b.check_in, b.check_out, '[)') && daterange($${fromIndex}::date, $${toIndex}::date, '[)'))`);
  }

  return { clauses, values };
}

function orderBy(filters: SearchFilters): string {
  switch (filters.sort) {
    case "price-low":
      return `coalesce(l.nightly_usd, p.base_price_usd) ASC, p.name ASC`;
    case "price-high":
      return `coalesce(l.nightly_usd, p.base_price_usd) DESC, p.name ASC`;
    case "newest":
      return `p.created_at DESC, p.name ASC`;
    case "rating":
      return `p.rating DESC, p.review_count DESC, p.name ASC`;
    case "distance":
      return filters.lat !== undefined && filters.lng !== undefined
        ? `(abs(coalesce(p.latitude, 0) - ${filters.lat}) + abs(coalesce(p.longitude, 0) - ${filters.lng})) ASC, p.rating DESC`
        : `p.rating DESC, p.review_count DESC`;
    default:
      return `p.rating DESC, p.review_count DESC, coalesce(l.nightly_usd, p.base_price_usd) ASC`;
  }
}

export async function searchProperties(filters: SearchFilters): Promise<{ items: PropertyDto[]; total: number }> {
  const locale = filters.locale ?? "en";
  const baseValues: unknown[] = [locale];
  const where = buildWhere(filters, 2);
  const values = [...baseValues, ...where.values];
  const whereSql = where.clauses.length ? `WHERE ${where.clauses.join("\n      AND ")}` : "";

  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;

  const rows = await query<PropertyRow>(
    `${selectProperty("$1")}
     ${whereSql}
     ORDER BY ${orderBy(filters)}
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    [...values, filters.limit, filters.offset],
    { label: "properties.search" },
  );

  const countRow = await queryOne<{ total: string }>(
    // $1 is the locale: unused here, but every filter below is numbered from
    // $2, so the placeholder has to stay in the parameter list.
    `SELECT count(*)::text AS total, $1::text AS locale
       FROM property p
       LEFT JOIN host_profile h ON h.user_id = p.host_id
       LEFT JOIN listing l ON l.property_id = p.id
     ${whereSql}`,
    values,
    { label: "properties.searchCount" },
  );

  return { items: rows.map(mapProperty), total: Number(countRow?.total ?? 0) };
}

/**
 * Ids of the stays that cannot take those nights: a night blocked on the host
 * calendar, or a live booking overlapping the range. The search page uses it
 * to hide stays that are not free for the dates the guest picked.
 */
export async function unavailablePropertyIds(from: string, to: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT DISTINCT cn.property_id AS id
       FROM calendar_night cn
      WHERE cn.blocked = true AND cn.night >= $1::date AND cn.night < $2::date
      UNION
     SELECT DISTINCT b.property_id AS id
       FROM booking b
      WHERE b.status IN ('pending', 'confirmed', 'completed')
        AND daterange(b.check_in, b.check_out, '[)') && daterange($1::date, $2::date, '[)')`,
    [from, to],
    { label: "properties.unavailable" },
  );
  return rows.map((row) => row.id);
}

export async function countByCategory(filters: SearchFilters): Promise<Record<string, number>> {
  const where = buildWhere({ ...filters, category: undefined }, 1);
  const whereSql = where.clauses.length ? `WHERE ${where.clauses.join("\n      AND ")}` : "";
  const rows = await query<{ category: string; total: string }>(
    `SELECT p.category::text AS category, count(*)::text AS total
       FROM property p
       LEFT JOIN host_profile h ON h.user_id = p.host_id
       LEFT JOIN listing l ON l.property_id = p.id
     ${whereSql}
     GROUP BY p.category`,
    where.values,
    { label: "properties.countByCategory" },
  );

  const counts: Record<string, number> = { all: 0 };
  for (const row of rows) {
    counts[row.category] = Number(row.total);
    counts["all"] = (counts["all"] ?? 0) + Number(row.total);
  }
  return counts;
}

export async function findPropertyById(
  id: string,
  options: { locale?: string; includeUnpublished?: boolean } = {},
): Promise<PropertyDto | null> {
  const visibility = options.includeUnpublished ? "" : `AND l.status = 'published' AND l.approved = true`;
  const row = await queryOne<PropertyRow>(
    `${selectProperty("$2")} WHERE p.id = $1 ${visibility}`,
    [id, options.locale ?? "en"],
    { label: "properties.findById" },
  );
  return row ? mapProperty(row) : null;
}

export async function propertyOwnerId(propertyId: string): Promise<{ hostId: string | null } | null> {
  const row = await queryOne<{ host_id: string | null }>(`SELECT host_id FROM property WHERE id = $1`, [propertyId], {
    label: "properties.owner",
  });
  return row ? { hostId: row.host_id } : null;
}

/** Destination coordinates used by the "sort by distance" option. */
export async function destinationCoords(where: string): Promise<{ lat: number; lng: number } | null> {
  const row = await queryOne<{ latitude: string; longitude: string }>(
    `SELECT latitude, longitude FROM property
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        AND (deaccent(city) LIKE '%' || deaccent($1) || '%' OR deaccent(country) LIKE '%' || deaccent($1) || '%')
      LIMIT 1`,
    [where],
    { label: "properties.destinationCoords" },
  );
  return row ? { lat: Number(row.latitude), lng: Number(row.longitude) } : null;
}
