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
export async function calendarMap(propertyId: string, from: string, to: string): Promise<CalendarMap> {
  const rows = await query<NightRow>(
    `SELECT night, blocked, price_usd, note FROM calendar_night
      WHERE property_id = $1 AND night >= $2::date AND night < $3::date`,
    [propertyId, from, to],
    { label: "calendar.map" },
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

  await query(
    `INSERT INTO calendar_night (property_id, night, blocked, price_usd, note, updated_at)
     SELECT $1, night::date, blocked, price_usd, note, now()
       FROM unnest($2::date[], $3::boolean[], $4::numeric[], $5::text[]) AS t(night, blocked, price_usd, note)
     ON CONFLICT (property_id, night) DO UPDATE
       SET blocked   = coalesce(excluded.blocked, calendar_night.blocked),
           price_usd = excluded.price_usd,
           note      = excluded.note,
           updated_at = now()`,
    [
      propertyId,
      nights.map((entry) => entry.night),
      nights.map((entry) => entry.blocked ?? false),
      nights.map((entry) => entry.priceUsd ?? null),
      nights.map((entry) => entry.note ?? null),
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
