import type { PoolClient } from "pg";

import { stayNights } from "@/core/dates.js";

import { query } from "@/db/query.js";

export type CalendarNight = { night: string; blocked: boolean; priceUsd: number | null; note: string | null };

export type CalendarMap = Record<string, { blocked: boolean; priceUsd: number | null }>;

type NightRow = { night: Date | string; blocked: boolean; price_usd: string | null; note: string | null };

function isoNight(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function mapNight(row: NightRow): CalendarNight {
  return {
    night: isoNight(row.night),
    blocked: row.blocked,
    priceUsd: row.price_usd === null ? null : Number(row.price_usd),
    note: row.note,
  };
}

/**
 * Host-owned overrides plus the nights taken by live bookings, so the guest
 * date picker and the host calendar read from one place.
 */
export async function calendarForProperty(
  propertyId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ propertyId: string; nights: CalendarNight[]; bookedNights: string[] }> {
  const clauses = ["property_id = $1"];
  const values: unknown[] = [propertyId];
  if (range.from) {
    values.push(range.from);
    clauses.push(`night >= $${values.length}::date`);
  }
  if (range.to) {
    values.push(range.to);
    clauses.push(`night < $${values.length}::date`);
  }

  const nights = await query<NightRow>(
    `SELECT night, blocked, price_usd, note FROM calendar_night
      WHERE ${clauses.join(" AND ")}
      ORDER BY night`,
    values,
    { label: "calendar.nights" },
  );

  const bookingValues: unknown[] = [propertyId];
  let bookingRange = "";
  if (range.from && range.to) {
    bookingValues.push(range.from, range.to);
    bookingRange = ` AND daterange(check_in, check_out, '[)') && daterange($2::date, $3::date, '[)')`;
  }

  const bookings = await query<{ check_in: Date | string; check_out: Date | string }>(
    `SELECT check_in, check_out FROM booking
      WHERE property_id = $1 AND status IN ('pending', 'confirmed', 'completed')${bookingRange}`,
    bookingValues,
    { label: "calendar.bookedNights" },
  );

  const booked = new Set<string>();
  for (const row of bookings) {
    for (const night of stayNights(isoNight(row.check_in), isoNight(row.check_out))) booked.add(night);
  }

  return {
    propertyId,
    nights: nights.map(mapNight),
    bookedNights: [...booked].sort(),
  };
}

/** Nights as a lookup map, the shape the quote engine expects. */
export async function calendarMap(
  propertyId: string,
  from: string,
  to: string,
  client?: PoolClient,
): Promise<CalendarMap> {
  const rows = await query<NightRow>(
    `SELECT night, blocked, price_usd, note FROM calendar_night
      WHERE property_id = $1 AND night >= $2::date AND night < $3::date`,
    [propertyId, from, to],
    { client, label: "calendar.map" },
  );


  const map: CalendarMap = {};
  for (const row of rows) {
    map[isoNight(row.night)] = { blocked: row.blocked, priceUsd: row.price_usd === null ? null : Number(row.price_usd) };
  }
  return map;
}

/** Upserts one or many nights (host calendar: block, unblock, price override). */
export async function saveCalendarNights(
  propertyId: string,
  nights: { night: string; blocked?: boolean; priceUsd?: number | null; note?: string | null }[],
): Promise<CalendarNight[]> {
  if (!nights.length) return [];

  // Only the fields the caller actually sent are written. Sending just a price
  // must not unblock the night, and blocking a night must not wipe its price
  // override, so each field carries a "was it provided" flag.
  await query(
    `WITH input AS (
       SELECT night::date AS night, blocked, set_blocked, price_usd, set_price, note, set_note
         FROM unnest($2::date[], $3::boolean[], $4::boolean[], $5::numeric[], $6::boolean[], $7::text[], $8::boolean[])
                AS t(night, blocked, set_blocked, price_usd, set_price, note, set_note)
     ),
     updated AS (
       UPDATE calendar_night c
          SET blocked    = CASE WHEN i.set_blocked THEN coalesce(i.blocked, false) ELSE c.blocked END,
              price_usd  = CASE WHEN i.set_price THEN i.price_usd ELSE c.price_usd END,
              note       = CASE WHEN i.set_note THEN i.note ELSE c.note END,
              updated_at = now()
         FROM input i
        WHERE c.property_id = $1 AND c.night = i.night
        RETURNING c.night
     )
     INSERT INTO calendar_night (property_id, night, blocked, price_usd, note, updated_at)
     SELECT $1, i.night, coalesce(i.blocked, false), i.price_usd, i.note, now()
       FROM input i
      WHERE NOT EXISTS (SELECT 1 FROM updated u WHERE u.night = i.night)`,
    [
      propertyId,
      nights.map((entry) => entry.night),
      nights.map((entry) => entry.blocked ?? null),
      nights.map((entry) => entry.blocked !== undefined),
      nights.map((entry) => entry.priceUsd ?? null),
      nights.map((entry) => "priceUsd" in entry),
      nights.map((entry) => entry.note ?? null),
      nights.map((entry) => "note" in entry),
    ],
    { label: "calendar.save" },
  );

  const rows = await query<NightRow>(
    `SELECT night, blocked, price_usd, note FROM calendar_night
      WHERE property_id = $1 AND night = ANY($2::date[]) ORDER BY night`,
    [propertyId, nights.map((entry) => entry.night)],
    { label: "calendar.saved" },
  );
  return rows.map(mapNight);
}

/** Blocks or clears every night in a range, inclusive of `from`, exclusive of `to`. */
export async function setRangeBlocked(
  propertyId: string,
  from: string,
  to: string,
  blocked: boolean,
  note: string | null = null,
): Promise<CalendarNight[]> {
  const nights = stayNights(from, to).map((night) => ({ night, blocked, note }));
  return saveCalendarNights(propertyId, nights);
}

export async function clearCalendarNights(propertyId: string, nights: string[]): Promise<void> {
  if (!nights.length) return;
  await query(`DELETE FROM calendar_night WHERE property_id = $1 AND night = ANY($2::date[])`, [propertyId, nights], {
    label: "calendar.clear",
  });
}
