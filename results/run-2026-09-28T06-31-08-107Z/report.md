# KV cache benchmark

- Run: `run-2026-09-28T06-31-08-107Z`
- Created: 2026-09-28T06:31:10.026Z
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
