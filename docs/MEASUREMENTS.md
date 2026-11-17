# Measurements

Only numbers recorded here may appear in the README or on a resume. Every row needs the date,
the commit, and the environment it ran on.

## What to measure

| Metric                                             | How                                                                 | Why it matters                                |
| -------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| Lost messages                                      | reliability script: published ids vs ids seen by chaos receiver     | the core promise; must be 0                   |
| Duplicate rate                                     | ids seen more than once ÷ published                                 | cost of at-least-once; explains the trade-off |
| Throughput                                         | k6 steady ingest; successful attempts per second, sustained 5 min   | capacity                                      |
| Time to first attempt                              | p50 / p95 / p99 from ingest to first attempt start                  | queue latency                                 |
| Ingest latency                                     | p50 / p95 / p99 of `POST /v1/messages`                              | producer experience                           |
| Recovery after worker kill                         | time until reaped deliveries are re-attempted                       | crash safety                                  |
| Fairness (M10)                                     | healthy endpoint p95 time-to-first-attempt while another is flooded | noisy-neighbor isolation                      |
| Test coverage of `packages/core` and `packages/db` | Vitest coverage                                                     | rigor                                         |

## Results

All runs: `pnpm torture` on a 2-CPU / 8 GB cloud sandbox, Node 22.23.4, Postgres 16 and every
Hookline process (API, 3 workers, chaos receiver, publisher) on the **same machine**. Retry delays
scaled ×0.001 so the full 10-attempt schedule fits in a run; lease 5 s. Four endpoints:
healthy, flaky (30% 500s, 10–150 ms), slow (300–800 ms), hostile (5% timeouts, 5% connection
resets, 20% 500s). Raw reports: `loadtests/results/<timestamp>/torture.{md,json}`.

| Date (UTC)       | Scenario                                          | Deliveries | Real SIGKILLs | Lost  | Unfinished | Duplicates  | Bad signatures | Wall time |
| ---------------- | ------------------------------------------------- | ---------- | ------------- | ----- | ---------- | ----------- | -------------- | --------- |
| 2026-11-16 19:31 | 2000 msgs × 4 endpoints, kill a worker every 4 s  | 8,000      | 34            | **0** | 0          | 148 (1.85%) | 0              | 141 s     |
| 2026-11-16 19:29 | 200 msgs × 4 endpoints, 2 workers, kill every 2 s | 800        | 18            | **0** | 0          | 75          | 0              | 38 s      |
| 2026-11-16 19:27 | 2000 msgs × 4 endpoints, no kills (baseline)      | 8,000      | 0             | **0** | 0          | 0           | 0              | 95 s      |

Time from ingest to first attempt (ms), same runs:

| Endpoint | Baseline p50 / p95 | With kills p50 / p95 |
| -------- | ------------------ | -------------------- |
| healthy  | 7,585 / 8,235      | 6,341 / 7,289        |
| flaky    | 9,852 / 12,207     | 13,125 / 17,901      |
| hostile  | 12,669 / 18,909    | 15,867 / 26,829      |
| slow     | 38,897 / 74,242    | 65,189 / 120,953     |

### How to read these

- **Lost = 0 across 42 real kills** is the claim this project is built to make. Duplicates are the
  price of at-least-once: a worker killed after the receiver answered but before the attempt was
  recorded means the delivery runs again. They concentrate on the slow endpoint, where a kill is
  most likely to land mid-request.
- **The latencies are backlog, not per-request speed.** 2,000 messages are published as fast as
  possible into a box whose 2 CPUs also run Postgres, three workers, the API, the receiver and the
  publisher. Slow's numbers are its own queue draining at its in-flight cap (12 × ~550 ms); the
  point is that healthy stays several times faster than slow while both share the workers
  (ADR 0005). Expect very different absolute numbers on real hardware with separate hosts.
- Nothing was tuned. No k6 run has been recorded yet.

### Harness corrections (kept for honesty)

Two earlier runs are excluded from the table because the harness, not Hookline, was wrong:

1. The first chaos run started processes through the `tsx` CLI wrapper. SIGKILL hit the wrapper
   and the real worker kept running as an orphan, so most "kills" never happened (it reported
   11 duplicates; real kills produce far more). Fixed: the harness now launches `node` directly
   with the tsx loader and fails if a killed process does not exit within 3 s.
2. A baseline run counted one delivery that was still legitimately retrying (8 random failures in
   a row on the 30%-failure endpoint, next attempt minutes away at ×0.01 scaling) as "lost"
   because the harness stopped waiting after 10 minutes. Fixed: "unfinished" is reported
   separately from "lost", the wait is sized to the scaled retry schedule, and the default
   scale is ×0.001.
