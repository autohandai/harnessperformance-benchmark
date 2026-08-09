# Harness performance benchmark

A cold-vs-warm prompt-cache and latency benchmark for the Autohand Code, Pi, Codex CLI, and Cline coding agents, across multiple inference providers. It records provider or agent cache telemetry, derives throughput metrics (write/read/cache-read speed, TTFT, total time), and refuses to call a faster second turn a cache hit unless cached input tokens are explicitly reported. Results render to a self-contained interactive dashboard.

## Providers

Beyond OpenRouter, the benchmark can target providers directly: `openrouter`, `openai`, `anthropic`, `google`, `nvidia`, `zai`. A local gateway retargets each agent's OpenAI-compatible request to the selected provider's real endpoint and injects that provider's credential, so agents keep their proven configuration and only the model id changes. Combinations that are architecturally unsupported (e.g. Anthropic's native-only wire, or Cline against a non-OpenRouter provider) are reported as `blocked`, never mis-measured. Credentials come from each provider's env var (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `NVIDIA_API_KEY`, `ZAI_API_KEY`) or the matching section of `~/.autohand/config.json`.

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
  --providers openrouter,nvidia \
  --model openrouter/free \
  --prefix-tokens 4096 \
  --rounds 3

# Render an interactive dashboard over every run in results/.
bun run benchmark -- dashboard --output results/dashboard.html
```

Results are written to `results/<run-id>/report.json` and `report.md`. Raw credentials, request headers, and prompt bodies are never persisted.

## Dashboard

`bun run benchmark -- dashboard` scans `results/run-*/report.json` and produces a single self-contained HTML file (no CDN, no bundler): grouped bar panels for each metric, a warm-speedup step chart, an agent/provider grouping toggle, a run picker with an all-runs trend view, and a raw-measurement table. All dynamic values flow through a JSON island and `textContent`, so untrusted provider/model strings cannot inject markup.

## Continuous benchmarking

`.github/workflows/ci.yml` runs `bun run proof` (tests, strict typecheck, lint, offline doctor) on every push and pull request. `.github/workflows/benchmark.yml` runs the live benchmark on a schedule (and on demand), builds the dashboard, and publishes it to the `gh-pages` branch, uploading it as a workflow artifact as a fallback. Only the provider secrets you configure on the repository are exercised; the rest report `blocked`.

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
