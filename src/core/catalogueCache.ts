import type { NextFunction, Request, Response } from "express";

/**
 * In-memory copy of public stays-search results.
 *
 * Freshness rule: a stale listing must never be shown. So the whole cache is
 * dropped after ANY successful write request (listing edit, delete, approval,
 * photo, price, booking — anything that could change what search returns),
 * and entries also expire after a short safety window in case data changes
 * outside a request (scripts, background jobs, another server instance).
 */
const SAFETY_TTL_MS = 15_000;
const MAX_ENTRIES = 500;

let version = 0;
const entries = new Map<string, { at: number; version: number; value: unknown }>();

export function catalogueVersion(): number {
  return version;
}

export function invalidateCatalogue(): void {
  version += 1;
  entries.clear();
}

export async function cachedCatalogue<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < SAFETY_TTL_MS) return hit.value as T;
  const startedAt = version;
  const value = await load();
  // A write that landed while we were loading makes this result suspect: skip storing it.
  if (startedAt === version) {
    if (entries.size >= MAX_ENTRIES) entries.clear();
    entries.set(key, { at: Date.now(), version, value });
  }
  return value;
}

/** Drops the catalogue cache once any write request finishes successfully. */
export function invalidateCatalogueOnWrite(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidateCatalogue();
    });
  }
  next();
}
