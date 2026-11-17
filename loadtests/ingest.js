// k6 load test for the ingest API.  k6 run -e API_KEY=hk_… -e RATE=200 loadtests/ingest.js

import { check } from "k6";
import http from "k6/http";

const RATE = Number(__ENV.RATE || 100);
export const options = {
  scenarios: {
    steady: { executor: "constant-arrival-rate", rate: RATE, timeUnit: "1s", duration: __ENV.DURATION || "2m", preAllocatedVUs: 50, maxVUs: 400 },
  },
  thresholds: { http_req_failed: ["rate<0.01"] },
};

export default function () {
  const res = http.post(
    `${__ENV.BASE_URL || "http://localhost:8080"}/v1/messages`,
    JSON.stringify({ event_type: "load.test", payload: { vu: __VU, iter: __ITER, at: Date.now() } }),
    { headers: { authorization: `Bearer ${__ENV.API_KEY}`, "content-type": "application/json" } },
  );
  check(res, { accepted: (r) => r.status === 202 });
}
