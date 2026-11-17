# Torture run 2026-11-16T19:29:13.568Z

200 messages × 4 endpoints, 2 workers, a worker SIGKILLed every 2 s (18 kills).
Machine: 2 CPUs, 8 GB, Node v22.23.4. Retry delays scaled ×0.001; lease 5 s.

**Lost: 0** · Unfinished: 0 · Duplicates: 75 · Bad signatures seen by receiver: 0 · Wall time: 38.4 s

| Endpoint | Deliveries | Delivered | Failed (terminal) | Lost | Unfinished | Duplicates | Attempts | Time to first attempt p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| slow | 200 | 200 | 0 | **0** | 0 | 59 | 200 | 12756 | 35025 |
| healthy | 200 | 200 | 0 | **0** | 0 | 6 | 200 | 873 | 1045 |
| flaky | 200 | 200 | 0 | **0** | 0 | 7 | 273 | 1207 | 2102 |
| hostile | 200 | 200 | 0 | **0** | 0 | 3 | 271 | 1252 | 6582 |
