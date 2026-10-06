# KV cache benchmark

- Run: `run-2026-10-06T06-22-50-050Z`
- Created: 2026-10-06T06:22:51.533Z
- Requested model: `openrouter/free`
- Target stable prefix: 4,096 estimated tokens
- Rounds: 3

| Agent | Status | Cache result | Warm cached tokens | Speedup | Detail |
| --- | --- | --- | ---: | ---: | --- |
| autohand | blocked | — | — | — | KV-cache worktree not found at /Users/igorcosta/Documents/autohand/cli-3-kv_cache_optimisations. |
| pi | blocked | — | — | — | No OpenRouter credential available. |
| codex | blocked | — | — | — | Executable not found on PATH. |
| cline | blocked | — | — | — | No OpenRouter credential available. |

A hit is recorded only when the warm turn reports cached input tokens greater than zero. Latency improvements without cache telemetry remain inconclusive. Routed model/provider changes are not compared.
