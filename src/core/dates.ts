/**
 * Date helpers. The server works in UTC only: the pool pins every PostgreSQL
 * session to UTC (`db/pool.ts`), so `today()` must agree with `CURRENT_DATE`.
 * The front-end keeps its own local-time helpers for the guest's calendar.
 */

export function toISODate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function today(): string {
  return toISODate(new Date());
}


/** Nights of a stay: check-in included, check-out excluded. */
export function stayNights(from: string, to: string): string[] {
  const start = new Date(`${toISODate(from)}T00:00:00Z`);
  const end = new Date(`${toISODate(to)}T00:00:00Z`);
  const out: string[] = [];
  for (let time = start.getTime(); time < end.getTime(); time += 86_400_000) {
    out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

export function daysBetween(from: string, to: string): number {
  const start = new Date(`${toISODate(from)}T00:00:00Z`).getTime();
  const end = new Date(`${toISODate(to)}T00:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function isWeekendNight(date: string): boolean {
  const day = new Date(`${toISODate(date)}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6; // Friday and Saturday nights
}
