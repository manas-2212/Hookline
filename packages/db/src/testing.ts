import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "./client.js";
import { migrate } from "./migrate.js";

/**
 * A throwaway, fully migrated database for one test file. Uses the server in DATABASE_URL
 * (docker compose locally, a service container in CI). Integration tests never mock the DB.
 */
export async function createTestDatabase(): Promise<{ url: string; db: Db; pool: pg.Pool; drop: () => Promise<void> }> {
  const base = process.env.DATABASE_URL ?? "postgres://hookline:hookline@localhost:5432/hookline";
  const name = `hookline_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  const { db, pool } = createDb(url.toString(), { max: 30 });
  return {
    url: url.toString(),
    db,
    pool,
    drop: async () => {
      await db.destroy();
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
