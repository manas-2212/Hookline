import { randomBytes } from "node:crypto";
import {
  addMembership,
  createApiKey,
  createApp,
  getUser,
  listApiKeys,
  listMemberships,
  overview,
  recentAttempts,
  revokeApiKey,
  upsertUser,
} from "@hookline/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth, requireApp, requireUser, SESSION_COOKIE, SESSION_DAYS, sessionValue } from "../auth.js";
import type { Deps } from "../deps.js";
import { notFound, Problem, unauthorized } from "../errors.js";

const STATE_COOKIE = "hl_oauth_state";

export function sessionRoutes(fastify: FastifyInstance, deps: Deps) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const secure = deps.cfg.NODE_ENV === "production";
  const github = Boolean(deps.cfg.GITHUB_CLIENT_ID && deps.cfg.GITHUB_CLIENT_SECRET);

  const startSession = (reply: FastifyReply, userId: string) =>
    reply.setCookie(SESSION_COOKIE, sessionValue(userId), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: SESSION_DAYS * 86_400,
    });

  app.get("/v1/auth/options", { schema: { tags: ["session"] } }, async () => ({ github, dev_login: deps.cfg.DEV_LOGIN }));

  app.post("/v1/auth/dev-login", { schema: { tags: ["session"], body: z.object({ login: z.string().regex(/^[a-z0-9-]{2,39}$/i) }) } }, async (req, reply) => {
    if (!deps.cfg.DEV_LOGIN) throw notFound("route");
    const user = await upsertUser(deps.db, { githubId: null, login: req.body.login, avatarUrl: null });
    startSession(reply, user.id);
    return { user };
  });

  app.get("/auth/github", async (_req, reply) => {
    if (!github) throw notFound("route");
    const state = randomBytes(16).toString("hex");
    reply.setCookie(STATE_COOKIE, state, { signed: true, httpOnly: true, sameSite: "lax", secure, path: "/auth", maxAge: 600 });
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", deps.cfg.GITHUB_CLIENT_ID ?? "");
    u.searchParams.set("redirect_uri", `${deps.cfg.PUBLIC_URL}/auth/github/callback`);
    u.searchParams.set("scope", "read:user");
    u.searchParams.set("state", state);
    return reply.redirect(u.toString());
  });

  app.get("/auth/github/callback", { schema: { querystring: z.object({ code: z.string(), state: z.string() }) } }, async (req, reply) => {
    if (!github) throw notFound("route");
    const raw = req.cookies[STATE_COOKIE];
    const saved = raw ? req.unsignCookie(raw) : null;
    if (!saved?.valid || saved.value !== req.query.state) throw new Problem(400, "Bad Request", "OAuth state mismatch");
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: deps.cfg.GITHUB_CLIENT_ID,
        client_secret: deps.cfg.GITHUB_CLIENT_SECRET,
        code: req.query.code,
      }),
    });
    const token = z.object({ access_token: z.string() }).safeParse(await tokenRes.json());
    if (!token.success) throw unauthorized("GitHub did not return a token");
    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.data.access_token}`, "user-agent": "hookline" },
    });
    const gh = z.object({ id: z.number(), login: z.string(), avatar_url: z.string().nullable() }).parse(await userRes.json());
    const user = await upsertUser(deps.db, { githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url });
    reply.clearCookie(STATE_COOKIE, { path: "/auth" });
    startSession(reply, user.id);
    return reply.redirect("/");
  });

  app.post("/v1/auth/logout", { schema: { tags: ["session"] } }, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });

  app.get("/v1/me", { schema: { tags: ["session"] } }, async (req) => {
    const userId = requireUser(req);
    const user = await getUser(deps.db, userId);
    if (!user) throw unauthorized();
    return { user, apps: await listMemberships(deps.db, userId) };
  });

  app.post(
    "/v1/apps",
    { schema: { tags: ["session"], summary: "Create an app; the caller becomes its owner", body: z.object({ name: z.string().min(1).max(100) }) } },
    async (req, reply) => {
      const userId = requireUser(req);
      // Custom header requirement doubles as CSRF protection for cookie-authenticated writes.
      if (!req.headers["x-hookline-csrf"]) throw new Problem(400, "Bad Request", "x-hookline-csrf header required");
      const created = await createApp(deps.db, req.body.name);
      await addMembership(deps.db, userId, created.id, "owner");
      return reply.status(201).send(created);
    },
  );

  app.get("/v1/api-keys", { schema: { tags: ["api-keys"] }, preHandler: requireApp(deps, "owner") }, async (req) => {
    return { items: await listApiKeys(deps.db, auth(req).appId) };
  });

  app.post(
    "/v1/api-keys",
    { schema: { tags: ["api-keys"], body: z.object({ label: z.string().max(100).nullable().optional() }) }, preHandler: requireApp(deps, "owner") },
    async (req, reply) => {
      const k = await createApiKey(deps.db, auth(req).appId, req.body.label ?? null);
      return reply.status(201).send(k);
    },
  );

  app.delete(
    "/v1/api-keys/:id",
    { schema: { tags: ["api-keys"], params: z.object({ id: z.string().uuid() }) }, preHandler: requireApp(deps, "owner") },
    async (req, reply) => {
      if (!(await revokeApiKey(deps.db, auth(req).appId, req.params.id))) throw notFound("api key");
      return reply.status(204).send();
    },
  );

  app.get(
    "/v1/attempts/recent",
    { schema: { tags: ["stats"], querystring: z.object({ seconds: z.coerce.number().int().min(1).max(3600).default(120) }) }, preHandler: requireApp(deps) },
    async (req) => ({ items: await recentAttempts(deps.db, auth(req).appId, req.query.seconds) }),
  );

  app.get("/v1/stats/overview", { schema: { tags: ["stats"] }, preHandler: requireApp(deps) }, async (req) => overview(deps.db, auth(req).appId));
}
