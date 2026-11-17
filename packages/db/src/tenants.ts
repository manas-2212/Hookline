import { generateApiKey, sha256 } from "@hookline/core";
import { sql } from "kysely";
import type { Db } from "./client.js";
import type { Role } from "./schema.js";

export async function createApp(db: Db, name: string): Promise<{ id: string; name: string }> {
  return db.insertInto("apps").values({ name }).returning(["id", "name"]).executeTakeFirstOrThrow();
}

export async function createApiKey(db: Db, appId: string, label: string | null = null): Promise<{ id: string; key: string; prefix: string }> {
  const { key, prefix, hash } = generateApiKey();
  const row = await db.insertInto("api_keys").values({ app_id: appId, prefix, key_hash: hash, label }).returning("id").executeTakeFirstOrThrow();
  return { id: row.id, key, prefix };
}

/** Lookup is by SHA-256 of the presented key: an index probe, no string comparison of secrets. */
export async function findAppByApiKey(db: Db, key: string): Promise<{ app_id: string; key_id: string } | undefined> {
  return db.selectFrom("api_keys").select(["app_id", "id as key_id"]).where("key_hash", "=", sha256(key)).where("revoked_at", "is", null).executeTakeFirst();
}

export async function listApiKeys(db: Db, appId: string) {
  return db
    .selectFrom("api_keys")
    .select(["id", "prefix", "label", "created_at", "revoked_at"])
    .where("app_id", "=", appId)
    .orderBy("created_at", "desc")
    .execute();
}

export async function revokeApiKey(db: Db, appId: string, keyId: string): Promise<boolean> {
  const r = await db
    .updateTable("api_keys")
    .set({ revoked_at: sql`now()` })
    .where("id", "=", keyId)
    .where("app_id", "=", appId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

export async function upsertUser(db: Db, u: { githubId: number | null; login: string; avatarUrl: string | null }) {
  return db
    .insertInto("users")
    .values({ github_id: u.githubId, login: u.login, avatar_url: u.avatarUrl })
    .onConflict((oc) => oc.column("login").doUpdateSet({ avatar_url: u.avatarUrl, github_id: u.githubId }))
    .returning(["id", "login", "avatar_url"])
    .executeTakeFirstOrThrow();
}

export async function getUser(db: Db, userId: string) {
  return db.selectFrom("users").select(["id", "login", "avatar_url"]).where("id", "=", userId).executeTakeFirst();
}

export async function addMembership(db: Db, userId: string, appId: string, role: Role): Promise<void> {
  await db
    .insertInto("memberships")
    .values({ user_id: userId, app_id: appId, role })
    .onConflict((oc) => oc.columns(["user_id", "app_id"]).doUpdateSet({ role }))
    .execute();
}

export async function listMemberships(db: Db, userId: string) {
  return db
    .selectFrom("memberships")
    .innerJoin("apps", "apps.id", "memberships.app_id")
    .select(["apps.id", "apps.name", "memberships.role"])
    .where("memberships.user_id", "=", userId)
    .orderBy("apps.created_at")
    .execute();
}

export async function getRole(db: Db, userId: string, appId: string): Promise<Role | undefined> {
  const r = await db.selectFrom("memberships").select("role").where("user_id", "=", userId).where("app_id", "=", appId).executeTakeFirst();
  return r?.role;
}
