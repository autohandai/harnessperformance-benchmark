# KV Cache Benchmark Research

Date: 2026-08-01

## Local repo check

- `/Users/igorcosta/Documents/autohand/bench` was not present at inspection time.
- `/Users/igorcosta/Documents/autohand/benchmarks` exists but is empty, so there was no local `AGENTS.md`, docs convention, or benchmark code to extend.
- This note therefore uses the requested fallback path.

## Executive summary

There is no existing off-the-shelf benchmark I found that can compare Pi, Codex CLI, Autohand Code CLI, and Cline fairly on provider-side prompt-cache behavior while also reporting cache-read tokens, cache-write tokens, TTFT, end-to-end latency, resolved provider/model, and cold-vs-warm turns.

The two closest starting points are:

1. `compare` in this workspace for agent-level CLI orchestration, isolated workspaces, TTFT-style timings, and end-to-end latency.
2. `prompt-cache-bench` for provider-level prompt-cache, routing, TTFT, and cost experiments.

Neither covers the full requirement alone:

- `compare` is agent-aware, but it does not capture cache-read/write tokens or resolved provider/model, and it has no built-in Cline adapter.
- `prompt-cache-bench` is cache-aware, but it benchmarks API requests, not coding-agent CLIs.

## Best existing candidate

### 1. `/Users/igorcosta/Documents/autohand/compare`

What it already does well:

- Benchmarks coding-agent CLIs side by side from fresh seeded workspaces.
- Has built-in adapters for `autohand`, `codex`, and `pi`.
- Records `firstByte`, `firstToken`, `firstTool`, and `exit`, so it already measures TTFT-style and end-to-end latency.
- Persists selected `provider`, `model`, and `reasoningEffort` as harness metadata.
- Prevents workspace artifact leakage between runs.

What blocks it from answering the full KV/prompt-cache question:

- No built-in Cline adapter. Unknown tools fall back to the generic adapter, which is opaque and emits no parsed token/tool/usage events.
- Metrics schema only stores `inputTokens`, `outputTokens`, and optional `costUsd`; there is no place for `cached_tokens`, `cache_write_tokens`, resolved provider, or resolved routed model.
- Autohand adapter parses token/tool events only.
- Codex adapter parses input/output usage only.
- Pi adapter intentionally does not parse Pi JSON yet.
- The stored `provider` is the configured harness/provider selection, not the provider actually resolved by OpenRouter on a routed turn.

Conclusion: `compare` is the closest practical base, but it is not sufficient today.

### 2. `InfronAI/prompt-cache-bench`

What it already does well:

- Benchmarks prompt cache hit rate, actual cost, throughput, latency, TTFT, and provider-routing behavior.
- Publishes reproducible A/B experiment code and raw datasets.
- Focuses directly on provider-side cache and routing effects.

What blocks it from answering the full agent question:

- It is API-layer benchmarking, not coding-agent CLI benchmarking.
- It does not orchestrate Pi, Codex CLI, Autohand Code CLI, or Cline sessions in seeded workspaces.
- It does not measure tool-loop behavior or agent end-of-turn semantics.

Conclusion: useful methodology reference for cache experiments, not a direct benchmark for the four CLIs.

### 3. Terminal-Bench family

- Useful for task-success benchmarking in terminal environments.
- Not designed to report provider-side cache-read/write accounting or resolved routed provider/model.

Conclusion: not a fit for this requirement.

## Agent-by-agent surface check

### Autohand Code CLI

- Headless structured output exists: `autohand -p ... --output-format stream-json`.
- OpenRouter is a supported provider.
- Provider usage in current local source normalizes to prompt/completion/total tokens only.
- Current local `compare` integration does not capture cache-read/write fields.

Fit: good for agent orchestration and latency measurement; not enough for provider-side cache accounting without extra instrumentation.

### OpenAI Codex CLI

- Headless structured mode exists via `codex exec --json`.
- OpenRouter has an official Codex CLI integration guide.
- Codex is the strongest of the four for machine-readable non-interactive execution.
- However, official open Codex issue `#32479` shows `cache_write_tokens` are still dropped from Codex token usage/rollout telemetry for GPT-5.6-era caching.

Fit: viable for TTFT and end-to-end latency; not sufficient by itself for cache-write accounting.

### Pi Coding Agent

- Non-interactive JSON mode exists: `--mode json`.
- Ephemeral runs exist: `--no-session`.
- Custom providers via `~/.pi/agent/models.json` allow OpenAI-compatible/OpenRouter setups.
- Official Pi issue `#2802` shows streamed OpenAI-compatible usage dropped `cache_write_tokens` on the streaming path.

Fit: viable for CLI execution and custom-provider routing; current cache-write observability is not reliable enough for the requested benchmark.

### Cline CLI

- Headless CLI exists.
- JSON output exists: `--json`.
- Provider and model overrides exist: `-P`, `-m`, plus `--thinking`.
- Official Cline OpenRouter docs support OpenRouter configuration.
- Current docs do not describe prompt-cache usage fields in CLI JSON output.
- Official Cline issue `#6996` shows broader JSON-output coverage gaps across CLI commands, and local `compare` would treat Cline as an opaque generic adapter unless a dedicated adapter is added.

Fit: benchmarkable only after custom adapter work; not covered by an existing fair harness.

## Can an existing benchmark compare all four fairly?

No.

The closest answer is:

- `compare` can compare Autohand, Codex, and Pi today at the agent level.
- `compare` can technically launch Cline through the generic adapter, but that is not a fair or equivalent measurement surface because it loses parsed event timing, tool timing, and usage telemetry.
- `prompt-cache-bench` can compare provider-side cache behavior, but not the four CLIs as coding agents.

So there is no existing benchmark that already gives all of:

- all four agents
- same seeded workspace/task harness
- cache-read tokens
- cache-write tokens
- TTFT
- end-to-end latency
- resolved provider/model
- controlled cold-vs-warm turns
- protection against response-cache false positives

## What a fair benchmark would need

Minimum benchmark contract:

1. One agent harness per CLI with structured non-interactive output.
2. Shared seeded workspace and identical prompt/task contract.
3. Cold turn and warm turn pairs per agent.
4. Provider-side accounting source of truth for:
   - `cached_tokens`
   - `cache_write_tokens`
   - cost
   - resolved routed provider
   - resolved routed model
5. Agent-side timings for:
   - process spawn
   - first byte / first visible output
   - first tool call
   - first token / first response
   - total completion time

## How to avoid response-cache false positives

This part is important for OpenRouter specifically.

OpenRouter now supports a separate response cache for identical requests. If enabled, repeated identical calls can return immediately with zero billed tokens, which would look like a dramatic cache win but is not provider-side prompt caching.

For a valid prompt-cache benchmark:

- Do not send `X-OpenRouter-Cache: true`.
- Keep a stable reusable prefix, but vary the suffix between cold and warm turns so the request is not byte-identical.
- Reuse the same `session_id` or `prompt_cache_key` so OpenRouter sticky routing keeps turns on the same provider.
- Capture OpenRouter generation metadata after each request so resolved provider/model and usage are read from the provider-facing source of truth rather than inferred from CLI logs.

For GPT-5.6-family OpenAI caching behavior specifically:

- Use the same `prompt_cache_key`.
- Place explicit cache breakpoints after the stable prefix when possible.
- Prefer explicit cache mode when measuring write/read economics, because changing suffix content can otherwise create misleading extra writes or zero-read turns.

## `openrouter/free` fairness warning

If the benchmark uses `openrouter/free`, resolved model/provider must be captured per turn.

Why:

- `openrouter/free` is a router, not a single underlying model.
- The underlying model and provider can vary across requests.
- That makes cross-agent fairness weaker unless every run records the routed model/provider and results are grouped by what actually ran.

If the goal is strict apples-to-apples cache behavior, a single concrete OpenRouter model is a better benchmark target than `openrouter/free`.

## Recommendation

Use `compare` as the orchestration base, not as the final answer.

It is the nearest agent-level harness already in this workspace, but it needs:

- a dedicated Cline adapter
- per-agent extraction of provider request/generation IDs where possible
- a provider-side OpenRouter usage/generation collector for cache-read/write and resolved provider/model
- cold/warm run logic that varies request suffixes and never enables OpenRouter response caching

Without those additions, no current benchmark I found can answer the user’s question credibly.

## Sources and references

### Local workspace

1. `/Users/igorcosta/Documents/autohand/compare/README.md`
2. `/Users/igorcosta/Documents/autohand/compare/src/types.ts`
3. `/Users/igorcosta/Documents/autohand/compare/src/adapters/autohand.ts`
4. `/Users/igorcosta/Documents/autohand/compare/src/adapters/codex.ts`
5. `/Users/igorcosta/Documents/autohand/compare/src/adapters/pi.ts`
6. `/Users/igorcosta/Documents/autohand/compare/src/adapters/generic.ts`
7. `/Users/igorcosta/Documents/autohand/cli-3/README.md`
8. `/Users/igorcosta/Documents/autohand/cli-3/src/providers/OpenRouterClient.ts`
9. `/Users/igorcosta/Documents/autohand/cli-3/src/providers/usage.ts`
10. `/Users/igorcosta/Documents/autohand/cli-3/src/types.ts`

### Official / primary web sources

1. OpenAI Prompt Caching guide: https://developers.openai.com/api/docs/guides/prompt-caching
2. OpenRouter Usage Accounting: https://openrouter.ai/docs/cookbook/administration/usage-accounting
3. OpenRouter prompt caching and sticky routing: https://openrouter.ai/docs/guides/best-practices/prompt-caching
4. OpenRouter response caching docs: https://openrouter.ai/docs/guides/features/response-caching
5. OpenRouter response caching announcement: https://openrouter.ai/blog/announcements/response-caching/
6. OpenRouter Codex CLI integration: https://openrouter.ai/docs/cookbook/coding-agents/codex-cli
7. OpenRouter generations metadata API: https://openrouter.ai/docs/api/api-reference/generations/get-request-%26-usage-metadata-for-a-generation
8. OpenRouter free router mention: https://openrouter.ai/docs/faq
9. Pi usage docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
10. Pi providers docs: https://pi.dev/docs/latest/providers
11. Pi issue `#2802` on dropped `cache_write_tokens`: https://github.com/earendil-works/pi/issues/2802
12. Cline CLI overview: https://docs.cline.bot/usage/cli-overview
13. Cline CLI reference: https://docs.cline.bot/cli/cli-reference
14. Cline OpenRouter provider docs: https://docs.cline.bot/provider-config/openrouter
15. Cline issue `#6996` on JSON output gaps: https://github.com/cline/cline/issues/6996
16. InfronAI `prompt-cache-bench`: https://github.com/InfronAI/prompt-cache-bench
17. Terminal-Bench: https://github.com/harbor-framework/terminal-bench
18. Codex issue `#32479` on dropped `cache_write_tokens`: https://github.com/openai/codex/issues/32479
