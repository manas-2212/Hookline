import { buildReceiver } from "./receiver.js";

const port = Number(process.env.CHAOS_PORT ?? 9000);
const app = buildReceiver({ logger: process.env.CHAOS_LOG === "true" });
await app.listen({ host: "0.0.0.0", port });
console.log(`chaos receiver on :${port} — POST /hook?fail=0.3&latency=50-400 …  stats at /_control/stats`);
