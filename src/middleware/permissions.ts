import type { NextFunction, Request, RequestHandler, Response } from "express";

import { apiError } from "@/core/errors.js";
import { requireAuth, type Role } from "@/middleware/auth.js";

/**
 * Admin capability model (client spec, section 7).
 *
 * `admin` is the super administrator: full access plus the right to create and
 * revoke the other admin roles. The three delegated roles exist so a
 * collaborator can be added later without reworking the back office.
 */
export const ADMIN_ROLES = ["admin", "moderator", "support", "accounting"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const CAPABILITIES = [
  "listings.read",
  "listings.moderate",
  "reviews.moderate",
  "users.read",
  "users.manage",
  "bookings.read",
  "bookings.manage",
  "finance.read",
  "finance.manage",
  "support.manage",
  "stats.read",
  "settings.manage",
  "admins.manage",
  "audit.read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<AdminRole, readonly Capability[]> = {
  // Super admin — everything.
  admin: CAPABILITIES,
  // Listing moderator — content only, never finance.
  moderator: ["listings.read", "listings.moderate", "reviews.moderate", "users.read", "bookings.read", "stats.read", "audit.read"],
  // Customer support — tickets, disputes, read-only on the bookings concerned.
  support: ["support.manage", "bookings.read", "users.read", "listings.read", "stats.read", "audit.read"],
  // Accounting — the finance module, read-only elsewhere.
  accounting: ["finance.read", "finance.manage", "bookings.read", "users.read", "stats.read", "audit.read"],
};

export function isAdminRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Every capability held across the caller's roles. */
export function capabilitiesFor(roles: readonly Role[]): Capability[] {
  const held = new Set<Capability>();
  for (const role of roles) {
    if (!isAdminRole(role)) continue;
    for (const capability of ROLE_CAPABILITIES[role]) held.add(capability);
  }
  return CAPABILITIES.filter((capability) => held.has(capability));
}

export function hasCapability(roles: readonly Role[], capability: Capability): boolean {
  return capabilitiesFor(roles).includes(capability);
}

/** Rejects unless the caller's roles grant the capability. */
export function requireCapability(capability: Capability): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const run = () => {
      const roles = req.auth?.roles ?? [];
      if (!hasCapability(roles, capability)) {
        return next(
          apiError("FORBIDDEN", {
            message: "Your administrator role does not allow this action.",
            details: { required: capability, held: capabilitiesFor(roles) },
          }),
        );
      }
      next();
    };

    if (req.auth) return run();
    requireAuth(req, _res, ((error?: unknown) => (error ? next(error) : run())) as NextFunction);
  };
}
