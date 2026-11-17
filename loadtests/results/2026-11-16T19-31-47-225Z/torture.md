# Torture run 2026-11-16T19:31:47.225Z

2000 messages × 4 endpoints, 3 workers, a worker SIGKILLed every 4 s (34 kills).
Machine: 2 CPUs, 8 GB, Node v22.23.4. Retry delays scaled ×0.001; lease 5 s.

**Lost: 0** · Unfinished: 0 · Duplicates: 148 · Bad signatures seen by receiver: 0 · Wall time: 141.0 s

| Endpoint | Deliveries | Delivered | Failed (terminal) | Lost | Unfinished | Duplicates | Attempts | Time to first attempt p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| slow | 2000 | 2000 | 0 | **0** | 0 | 103 | 2000 | 65189 | 120953 |
| healthy | 2000 | 2000 | 0 | **0** | 0 | 15 | 2000 | 6341 | 7289 |
| hostile | 2000 | 2000 | 0 | **0** | 0 | 14 | 2788 | 15867 | 26829 |
| flaky | 2000 | 2000 | 0 | **0** | 0 | 16 | 2851 | 13125 | 17901 |
