# OpenRouter free-router cache smoke results

Measured on 2026-08-01 with one cold/warm pair per agent and a 4,096-token estimated deterministic prefix. These are smoke results, not distribution-quality benchmarks; use at least three rounds and a concrete cache-capable model before comparing agents.

| Agent | Cold E2E | Warm E2E | Warm cache read | Result | Routing evidence |
| --- | ---: | ---: | ---: | --- | --- |
| Pi 0.83.0 | 1,553.62 ms | 458.05 ms | 3,040 / 3,079 input tokens | verified hit, 3.39x E2E speedup | Poolside `poolside/laguna-xs-2.1:free` on both turns |
| Autohand Code 0.8.2 | 14,793.35 ms | 41,427.44 ms | 0 | inconclusive | routed from `nvidia/nemotron-nano-9b-v2:free` to `nvidia/nemotron-3-super-120b-a12b:free` |
| Codex 0.146.0 | 11,231.79 ms | 10,726.23 ms | 0 | inconclusive | routed from `poolside/laguna-xs-2.1:free` to `nvidia/nemotron-3-nano-30b-a3b:free` |
| Cline 3.0.48 | 3,318.88 ms | 4,078.58 ms | 0 | cache miss; latency incomparable | native telemetry reports only `openrouter/free`, not the resolved route |

The Pi pair is the only measured pair that proves both a cache read and stable underlying routing. Its warm request reported a 98.73% cache-read ratio. Autohand Code and Codex changed underlying models, so their latency deltas cannot be attributed to caching. Cline explicitly reported zero cached tokens, but the free router's underlying model is unavailable in its native telemetry.

Evidence:

- [Pi report](../results/run-2026-08-01T12-14-30-499Z/report.md)
- [Autohand Code report](../results/run-2026-08-01T12-10-24-387Z/report.md)
- [Codex report](../results/run-2026-08-01T12-06-43-237Z/report.md)
- [Cline report](../results/run-2026-08-01T12-22-35-403Z/report.md)

Autohand Code, Pi, and Codex were measured through the local telemetry gateway, which disables OpenRouter's separate response cache and records the resolved model/provider returned by OpenRouter. Cline was measured through its native OpenRouter integration because its base URL is not configurable; its cold and warm prompts differ after the shared prefix, avoiding an identical-response-cache comparison.
