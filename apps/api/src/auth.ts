import { findAppByApiKey, getRole, type Role } from "@hookline/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Deps } from "./deps.js";
import { forbidden, notFound, Problem, unauthorized } from "./errors.js";

export interface AuthContext {
  appId: string;
  role: Role;
  via: "api_key" | "session";
  userId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const SESSION_COOKIE = "hl_session";
export const SESSION_DAYS = 7;

/** Signed cookie value: `${userId}.${expiresAtMs}`; the signature is added by @fastify/cookie. */
export function sessionValue(userId: string, now = Date.now()): string {
  return `${userId}.${now + SESSION_DAYS * 86_400_000}`;
}

export function readSessionUser(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return null;
  const [userId, exp] = un.value.split(".");
  if (!userId || !exp || Number(exp) < Date.now()) return null;
  return userId;
}

/**
 * App-scoped authentication. Two ways in:
 *  - `Authorization: Bearer hk_…` (producers, CLI): owner rights on the key's app.
 *  - dashboard session cookie + `x-hookline-app` header: role from memberships.
 *    Requiring a custom header on every session request also blocks cross-site form posts (CSRF).
 */
export function requireApp(deps: Deps, minRole: Role = "viewer", opts: { appFromQuery?: boolean } = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    let ctx: AuthContext | null = null;
    if (header?.startsWith("Bearer ")) {
      const found = await findAppByApiKey(deps.db, header.slice(7).trim());
      if (!found) throw unauthorized("invalid API key");
      ctx = { appId: found.app_id, role: "owner", via: "api_key" };
    } else {
      const userId = readSessionUser(req);
      if (!userId) throw unauthorized();
      // EventSource can't send headers, so the read-only SSE stream takes the app from ?app=.
      const fromQuery = opts.appFromQuery ? (req.query as { app?: unknown }).app : undefined;
      const appId = req.headers["x-hookline-app"] ?? fromQuery;
      if (typeof appId !== "string" || !/^[0-9a-f-]{36}$/i.test(appId)) {
        throw new Problem(400, "Bad Request", "x-hookline-app header required");
      }
      const role = await getRole(deps.db, userId, appId);
      if (!role) throw notFound("app"); // don't reveal that the app exists
      ctx = { appId, role, via: "session", userId };
    }
    if (minRole === "owner" && ctx.role !== "owner") throw forbidden();
    req.auth = ctx;
  };
}

export function requireUser(req: FastifyRequest): string {
  const userId = readSessionUser(req);
  if (!userId) throw unauthorized();
  return userId;
}

/** Narrow `req.auth` after the preHandler ran. */
export function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
