import { query, queryOne } from "@/db/query.js";
import { apiError } from "@/core/errors.js";
import { mapProperty, type PropertyDto } from "@/modules/properties/properties.repository.js";

/** Saved stays ("wishlist"), one row per user + property. */
export async function listFavoriteIds(userId: string): Promise<string[]> {
  const rows = await query<{ property_id: string }>(
    `SELECT property_id FROM favorite WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
    { label: "favorites.listIds" },
  );
  return rows.map((row) => row.property_id);
}

export async function listFavorites(userId: string, locale = "en"): Promise<PropertyDto[]> {
  const rows = await query(
    `SELECT p.*, p.category::text AS category, p.cancellation_policy::text AS cancellation_policy,
            h.display_name AS host_name, h.hosting_since, h.superhost AS host_superhost,
            l.id AS listing_id, l.status::text AS listing_status, l.approved AS listing_approved,
            l.nightly_usd, l.long_stay_enabled, l.long_stay_threshold, l.long_stay_discount,
            l.mobile_enabled, l.mobile_discount,
            t.location_label,
            (SELECT array_agg(a.amenity::text) FROM property_amenity a WHERE a.property_id = p.id) AS amenities,
            (SELECT array_agg(e.equipment_id) FROM property_equipment e WHERE e.property_id = p.id) AS equipment,
            (SELECT array_agg(g.tag) FROM property_tag g WHERE g.property_id = p.id) AS tags,
            (SELECT array_agg(ph.url ORDER BY ph.position) FROM property_photo ph WHERE ph.property_id = p.id) AS photos
       FROM favorite f
       JOIN property p ON p.id = f.property_id
       LEFT JOIN host_profile h ON h.user_id = p.host_id
       LEFT JOIN listing l ON l.property_id = p.id
       LEFT JOIN property_translation t ON t.property_id = p.id AND t.locale = $2
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC`,
    [userId, locale],
    { label: "favorites.list" },
  );
  return rows.map((row) => mapProperty(row as never));
}

export async function addFavorite(userId: string, propertyId: string): Promise<void> {
  const property = await queryOne<{ id: string }>(`SELECT id FROM property WHERE id = $1`, [propertyId], {
    label: "favorites.checkProperty",
  });
  if (!property) {
    throw apiError("NOT_FOUND", { message: `No stay exists with the id "${propertyId}".`, details: { propertyId } });
  }

  await query(
    `INSERT INTO favorite (user_id, property_id) VALUES ($1, $2) ON CONFLICT (user_id, property_id) DO NOTHING`,
    [userId, propertyId],
    { label: "favorites.add" },
  );
}

export async function removeFavorite(userId: string, propertyId: string): Promise<void> {
  await query(`DELETE FROM favorite WHERE user_id = $1 AND property_id = $2`, [userId, propertyId], {
    label: "favorites.remove",
  });
}

/** Replaces the whole list — used when a guest signs in with local favourites. */
export async function replaceFavorites(userId: string, propertyIds: string[]): Promise<string[]> {
  await query(`DELETE FROM favorite WHERE user_id = $1 AND NOT (property_id = ANY($2::text[]))`, [userId, propertyIds], {
    label: "favorites.pruneMissing",
  });
  if (propertyIds.length) {
    await query(
      `INSERT INTO favorite (user_id, property_id)
       SELECT $1, id FROM property WHERE id = ANY($2::text[])
       ON CONFLICT (user_id, property_id) DO NOTHING`,
      [userId, propertyIds],
      { label: "favorites.merge" },
    );
  }
  return listFavoriteIds(userId);
}
