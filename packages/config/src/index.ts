import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Load the nearest .env (searching up from the working directory) into process.env without
 * overriding variables that are already set. Production should set real environment variables.
 */
export function loadDotEnv(start: string = process.cwd()): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      const before = { ...process.env };
      process.loadEnvFile(file);
      for (const [k, v] of Object.entries(before)) process.env[k] = v; // real env wins
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("postgres://hookline:hookline@localhost:5432/hookline"),
  REDIS_URL: z.string().optional(),
  /** 32-byte key, base64. Encrypts endpoint signing secrets at rest. */
  ENCRYPTION_KEY: z
    .string()
    .default("ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzItYnl0ZXM=")
    .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64"),
  ALLOW_INSECURE_ENDPOINTS: bool,
  /** Comma-separated CIDRs that bypass the SSRF block list (tests, local chaos receiver). */
  ENDPOINT_ALLOWLIST: z.string().default(""),
  API_PORT: z.coerce.number().int().default(8080),
  PUBLIC_URL: z.string().default("http://localhost:8080"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(32),
  CLAIM_BATCH_SIZE: z.coerce.number().int().min(1).default(64),
  /** Max deliveries in flight at once for one endpoint (noisy-neighbor guard). */
  ENDPOINT_MAX_IN_FLIGHT: z.coerce.number().int().min(1).default(8),
  LEASE_SECONDS: z.coerce.number().int().min(2).default(60),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().default(15_000),
  CONNECT_TIMEOUT_MS: z.coerce.number().int().default(5_000),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  INGEST_RATE_PER_SEC: z.coerce.number().int().min(1).default(500),
  WORKER_METRICS_PORT: z.coerce.number().int().default(9464),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().default("dev-session-secret-change-me-please-32"),
  /** Enables a no-password "dev login" on the dashboard. Never enable in production. */
  DEV_LOGIN: bool,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  if (!env && process.env.NODE_ENV !== "test" && !process.env.VITEST) loadDotEnv();
  const parsed = schema.safeParse(env ?? process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  // A lease shorter than a request would let the reaper hand a delivery to a second worker
  // while the first is still sending it.
  if (cfg.LEASE_SECONDS * 1000 <= cfg.REQUEST_TIMEOUT_MS + 1000) {
    throw new Error("LEASE_SECONDS must exceed REQUEST_TIMEOUT_MS by more than 1 second");
  }
  if (cfg.NODE_ENV === "production") {
    if (cfg.DEV_LOGIN) throw new Error("DEV_LOGIN must not be enabled in production");
    if (cfg.SESSION_SECRET.startsWith("dev-")) throw new Error("Set SESSION_SECRET in production");
  }
  return cfg;
}
