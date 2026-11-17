# Torture run 2026-11-16T19:27:31.856Z

2000 messages × 4 endpoints, 3 workers, no kills (baseline).
Machine: 2 CPUs, 8 GB, Node v22.23.4. Retry delays scaled ×0.001; lease 5 s.

**Lost: 0** · Unfinished: 0 · Duplicates: 0 · Bad signatures seen by receiver: 0 · Wall time: 95.2 s

| Endpoint | Deliveries | Delivered | Failed (terminal) | Lost | Unfinished | Duplicates | Attempts | Time to first attempt p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| slow | 2000 | 2000 | 0 | **0** | 0 | 0 | 2000 | 38897 | 74242 |
| healthy | 2000 | 2000 | 0 | **0** | 0 | 0 | 2000 | 7585 | 8235 |
| hostile | 2000 | 2000 | 0 | **0** | 0 | 0 | 2791 | 12669 | 18909 |
| flaky | 2000 | 2000 | 0 | **0** | 0 | 0 | 2910 | 9852 | 12207 |
