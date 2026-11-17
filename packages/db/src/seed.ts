import { loadConfig } from "@hookline/config";
import { createDb } from "./client.js";
import { migrate } from "./migrate.js";
import { addMembership, createApiKey, createApp, upsertUser } from "./tenants.js";

/** Creates a demo app, an API key (printed once) and a "dev" dashboard user who owns the app. */
async function main() {
  const cfg = loadConfig();
  await migrate(cfg.DATABASE_URL);
  const { db } = createDb(cfg.DATABASE_URL, { max: 2 });
  const app = await createApp(db, process.argv[2] ?? "Demo app");
  const key = await createApiKey(db, app.id, "seed");
  const user = await upsertUser(db, { githubId: null, login: "dev", avatarUrl: null });
  await addMembership(db, user.id, app.id, "owner");
  console.log(`app:      ${app.name} (${app.id})`);
  console.log(`api key:  ${key.key}`);
  console.log("          (shown once — store it now)");
  console.log(`dashboard: dev login as "dev" owns this app`);
  await db.destroy();
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
