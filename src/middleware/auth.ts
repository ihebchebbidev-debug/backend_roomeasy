import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";

import { env } from "@/config/env.js";
import { apiError } from "@/core/errors.js";
import { queryOne } from "@/db/query.js";

export type Role = "guest" | "host" | "admin" | "moderator" | "support" | "accounting";

export type AuthContext = {
  userId: string;
  email: string;
  roles: Role[];
  verified: boolean;
};

export type TokenPayload = { sub: string; email: string; roles: Role[]; verified: boolean };

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    // env.JWT_EXPIRES_IN is a validated duration string ("15m", "7d") or seconds.
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    issuer: "nestara-backend",
  });
}

function readToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

async function contextFromToken(token: string, req: Request): Promise<AuthContext> {
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { issuer: "nestara-backend" }) as TokenPayload;
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw apiError(expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID", { cause: error });
  }

  // The token is only a hint: the account state is re-read so a suspension or a
  // role change takes effect immediately, without waiting for expiry.
  const account = await queryOne<{ id: string; email: string; suspended: boolean; verified: boolean; roles: Role[] }>(
    `SELECT u.id, u.email, u.suspended, u.verified,
            coalesce(array_agg(g.role) FILTER (WHERE g.role IS NOT NULL), '{}')::text[] AS roles
       FROM app_user u
       LEFT JOIN user_role_grant g ON g.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id`,
    [payload.sub],
    { label: "auth.loadAccount" },
  );

  if (!account) throw apiError("TOKEN_INVALID", { message: "The account on this session no longer exists." });
  if (account.suspended) {
    throw apiError("ACCOUNT_SUSPENDED", { details: { userId: account.id } });
  }

  const context: AuthContext = {
    userId: account.id,
    email: account.email,
    roles: account.roles.length ? account.roles : ["guest"],
    verified: account.verified,
  };
  req.auth = context;
  return context;
}

/** Attaches `req.auth` when a valid token is present; never rejects. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = readToken(req);
  if (!token) return next();
  contextFromToken(token, req)
    .then(() => next())
    .catch(next);
};

/**
 * Readable alias used by routes that serve both signed-in and anonymous
 * callers (for example a booking availability check).
 */
export const optionalAuth: RequestHandler = authenticate;

/** Rejects the request with 401 unless a valid token is present. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readToken(req);
  if (!token) {
    return next(
      apiError("UNAUTHENTICATED", {
        message: "Sign in to continue. Send the access token as `Authorization: Bearer <token>`.",
      }),
    );
  }
  contextFromToken(token, req)
    .then(() => next())
    .catch(next);
};

/** Rejects unless the caller holds at least one of the given roles. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const run = () => {
      const held = req.auth?.roles ?? [];
      if (!held.some((role) => roles.includes(role))) {
        return next(
          apiError("FORBIDDEN", {
            message: `This action requires the ${roles.join(" or ")} role.`,
            details: { required: roles, held },
          }),
        );
      }
      next();
    };

    if (req.auth) return run();
    requireAuth(req, _res, ((error?: unknown) => (error ? next(error) : run())) as NextFunction);
  };
}

export function currentUser(req: Request): AuthContext {
  if (!req.auth) throw apiError("UNAUTHENTICATED");
  return req.auth;
}

export function isAdmin(req: Request): boolean {
  return req.auth?.roles.includes("admin") === true;
}
