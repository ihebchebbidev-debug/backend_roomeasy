import type { NextFunction, Request, Response } from "express";

/**
 * Cache hints for read-only public endpoints.
 *
 * Anonymous catalogue reads (equipment list, published listings, a property
 * page) are identical for everybody, so they may be held briefly by the CDN
 * and revalidated in the background. Anything authenticated, or any write,
 * stays private and uncached.
 */

/** path prefix → seconds the CDN may serve the cached copy. */
const PUBLIC_GET_CACHE: { prefix: string; maxAge: number; swr: number }[] = [
  { prefix: "/api/equipment", maxAge: 3600, swr: 86_400 },
  { prefix: "/api/reviews", maxAge: 60, swr: 300 },
];

export function cacheControl(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Cache-Control", "no-store");
    next();
    return;
  }

  // A signed-in caller may see their own data on these same paths.
  const authenticated = Boolean(req.headers.authorization);
  const rule = authenticated ? undefined : PUBLIC_GET_CACHE.find((entry) => req.path.startsWith(entry.prefix));

  // Stays search: browsers must re-check every time (no copy kept by browsers
  // or relays), but an unchanged result comes back as a tiny 304 via ETag.
  if (!authenticated && (req.path === "/api/stays" || req.path === "/api/stays/")) {
    res.setHeader("Cache-Control", "no-cache");
    res.vary("Accept-Encoding");
  } else if (rule) {
    res.setHeader("Cache-Control", `public, max-age=0, s-maxage=${rule.maxAge}, stale-while-revalidate=${rule.swr}`);
    res.vary("Accept-Encoding");
  } else {
    res.setHeader("Cache-Control", "private, no-store");
  }

  next();
}
