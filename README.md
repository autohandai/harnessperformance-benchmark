# KV cache benchmark

This is a cold-vs-warm prompt-cache benchmark for Autohand Code, Pi, Codex CLI, and Cline using OpenRouter. It defaults to `openrouter/free`, records provider or agent cache telemetry, and refuses to call a faster second turn a cache hit unless cached input tokens are explicitly reported.

## Why this exists

No existing benchmark covers all four coding agents with cache reads/writes, first-byte and end-to-end timing, routed model/provider identity, isolated sessions, and response-cache protection. See [the research note](docs/kv-cache-benchmark-research.md) for the evaluated alternatives and primary sources.

## Install and verify

```sh
bun install
bun run proof
```

`proof` is offline. It runs the test suite, strict TypeScript checking, linting, and the installation doctor. The doctor never prints credentials.

Pi and Cline are pinned as project-local packages, so installing the benchmark does not replace the user's global CLIs. Codex is discovered from `PATH`; Autohand Code runs directly from the local KV-cache worktree.

## Run

```sh
export OPENROUTER_API_KEY=...

# Check installed CLI compatibility without making model requests.
bun run benchmark -- doctor

# Verify the provider path independently of any coding agent.
bun run benchmark -- control --model openrouter/free --prefix-tokens 4096

# Benchmark all compatible installed agents. Each round is two model requests.
bun run benchmark -- run \
  --agents autohand,pi,codex,cline \
  --model openrouter/free \
  --prefix-tokens 4096 \
  --rounds 3
```

Results are written to `results/<run-id>/report.json` and `report.md`. Raw credentials, request headers, and prompt bodies are never persisted.

If `OPENROUTER_API_KEY` is not exported, the benchmark can use the existing key in `~/.autohand/config.json`. The doctor reports only whether a credential is available, never its value.

## Measurement contract

- The cold and warm turns share a deterministic prefix and use different suffixes.
- The local gateway forces `X-OpenRouter-Cache: false`, preventing OpenRouter's separate identical-response cache from masquerading as a prompt-cache hit.
- A hit requires `cacheReadTokens > 0` from provider or agent telemetry.
- A reported zero is a miss. A missing cache field is inconclusive.
- If `openrouter/free` resolves to different underlying models or providers, that pair is marked incomparable.
- Agent state and config live in per-run temporary directories. The user's normal Codex, Pi, Autohand, and Cline configuration is not changed.

## Agent paths and known compatibility boundaries

- Autohand Code uses the local `kv_cache_optimisations` worktree by default. Override with `AUTOHAND_BENCH_REPO`.
- Pi uses RPC mode and an isolated `PI_CODING_AGENT_DIR` with OpenRouter session-affinity headers.
- Codex uses `codex exec --json` and a temporary Responses-compatible custom provider. OpenRouter/Codex schema compatibility failures remain visible in the report.
- Cline requires the current CLI with `--json`, `--provider`, and `--data-dir`. Its cold and warm measurements are independent one-shot requests carrying the complete shared prefix because current headless JSON resume rejects follow-up input with `--id`.

`openrouter/free` is intentionally the default requested by this experiment, but it is a router whose resolved model can change. For strict apples-to-apples latency comparisons, pass a concrete model ID that supports prompt caching.
