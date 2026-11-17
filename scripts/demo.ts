/**
 * Demo traffic for the dashboard. Needs the API, a worker and the chaos receiver running
 * (`pnpm dev`) with ALLOW_INSECURE_ENDPOINTS=true and ENDPOINT_ALLOWLIST=127.0.0.1/32.
 *
 *   HOOKLINE_API_KEY=hk_… pnpm demo -- --seconds 120 --rate 6
 *
 * Creates four endpoints on the chaos receiver (healthy, flaky, slow, broken) the first time,
 * then publishes a mix of realistic events.
 */
import { parseArgs } from "node:util";
import { Hookline } from "@hookline/sdk";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "120" },
    rate: { type: "string", default: "6" },
    receiver: { type: "string", default: "http://127.0.0.1:9000" },
  },
});
const apiKey = process.env.HOOKLINE_API_KEY;
if (!apiKey) {
  console.error("set HOOKLINE_API_KEY (pnpm db:seed prints one)");
  process.exit(1);
}
const h = new Hookline({ apiKey, baseUrl: process.env.HOOKLINE_URL ?? "http://localhost:8080" });
const rx = values.receiver;

const wanted = [
  { description: "Acme billing", q: "name=acme&latency=20-120", events: ["invoice.paid", "invoice.failed", "customer.created"] },
  { description: "Globex CRM", q: "name=globex&fail=0.25&latency=40-250", events: ["customer.created", "customer.updated"] },
  { description: "Initech warehouse", q: "name=initech&latency=600-1400", events: ["order.created", "order.shipped"] },
  { description: "Umbrella legacy ERP", q: "name=umbrella&status=503&retry_after=2", events: ["order.created"] },
];

const existing = (await h.endpoints.list()).items as Array<{ description: string | null }>;
for (const w of wanted) {
  if (existing.some((e) => e.description === w.description)) continue;
  const e = await h.endpoints.create({ url: `${rx}/hook?${w.q}`, description: w.description, event_types: w.events });
  await fetch(`${rx}/_control/secrets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: e.secret }) });
  console.log(`created ${w.description}`);
}

const types = ["invoice.paid", "invoice.failed", "customer.created", "customer.updated", "order.created", "order.shipped"];
const end = Date.now() + Number(values.seconds) * 1000;
let n = 0;
while (Date.now() < end) {
  const type = types[Math.floor(Math.random() * types.length)] ?? "order.created";
  const id = Math.random().toString(36).slice(2, 10);
  await h.messages.send(type, {
    id: `${type.split(".")[0]}_${id}`,
    amount: Math.round(Math.random() * 50_000) / 100,
    currency: "INR",
    created_at: new Date().toISOString(),
  });
  n++;
  await new Promise((r) => setTimeout(r, (1000 / Number(values.rate)) * (0.5 + Math.random())));
}
console.log(`sent ${n} messages`);
