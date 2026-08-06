# Multi-provider benchmark metrics & dashboard

Date: 2026-08-07
Status: approved, pending user review of this document

## Problem

`autohand-kv-cache-bench` measures prompt-cache latency (cold vs warm turns, cache
hit/miss, TTFT, cost) across four coding-agent CLIs — Autohand, Pi, Codex, Cline — but
only through OpenRouter, and only produces `report.json`/`report.md`. There is no way to:

- compare the same agents against providers called directly (Anthropic, OpenAI, Google,
  NVIDIA, Zai) instead of only OpenRouter-routed requests
- see derived throughput metrics (write speed, read speed, cache-read speed) — the raw
  inputs are already captured, but nothing computes them
- see any of this visually; the only output is a markdown table
- run this on a schedule and publish results anywhere

This spec covers the metrics extension, the provider abstraction, the static dashboard,
and the CI/distribution workflow as one project, per the user's explicit choice to design
all four together rather than sequence them into separate specs.

## Non-goals

- New task-success benchmark suites (Terminal-Bench-style pass/fail scoring). The
  screenshots that motivated this work are **style inspiration only** — dark theme,
  grouped bar charts with category tabs, step/line charts with inline end labels — applied
  to this repo's existing latency/cache/provider data, not a request to build new graded
  benchmark corpora.
- Full agent×provider parity. Some combinations are architecturally impossible (see
  "Provider abstraction" below) and are reported as `blocked`, not built.
- Checking out a second private repo (Autohand's CLI worktree) inside CI. Documented as a
  known follow-up, not solved here.

## Architecture overview

```
src/
  types.ts        — extended: ProviderId, provider field on TurnMeasurement/BenchmarkRound
  providers.ts     (new) — provider registry + resolveProviderCredential(provider)
  metrics.ts       (new) — pure derived-metric functions over TurnMeasurement
  gateway.ts       — extended: startGateway({ provider }), table-driven upstream/auth
  credentials.ts   — OpenRouter-specific helpers now delegate to providers.ts
  adapters.ts      — extended: each runX(options) takes a provider; unsupported
                     (agent, provider) pairs throw UnsupportedCombinationError → status "blocked"
  doctor.ts        — extended: per-provider credential + per-(agent,provider) readiness
  dashboard/
    data.ts        (new) — aggregates results/run-*/report.json into a DashboardDataset
    render.ts       (new) — pure DashboardDataset → self-contained HTML string
  index.ts         — extended: --provider flag on control/run; new `dashboard` command
.github/workflows/
  ci.yml           (new) — proof on every push/PR, no secrets
  benchmark.yml    (new) — scheduled + manual live run, commits results/, deploys dashboard
```

Nothing in this pipeline calls a model to *build* the report — metrics computation and
HTML rendering are deterministic TypeScript. The only model calls are the benchmark's
existing subject-under-test calls (the agent CLIs being measured).

## Data model changes

```ts
export type ProviderId = "openrouter" | "anthropic" | "openai" | "google" | "nvidia" | "zai";

export interface TurnMeasurement extends CacheTelemetry {
  // ...existing fields...
  provider: ProviderId;
}

export interface BenchmarkRound extends PairClassification {
  // ...existing fields... (cold/warm already carry `provider`)
}
```

`BenchmarkReport.agents` stays a flat list, but each `AgentBenchmarkResult` is now scoped
to one `(agent, provider)` pair, not just one agent. A single `run` invocation can request
multiple providers; the runner produces one `AgentBenchmarkResult` per (agent, provider)
combination that doctor reports as ready, and one `blocked` entry per combination it
doesn't.

`schemaVersion` bumps to `2`. Historical `report.json` files under `results/` are
schema-1 and lack `provider`; `dashboard/data.ts` treats a missing `provider` as
`"openrouter"` (the only provider that ever existed under schema 1), so existing results
keep working in the dashboard without migration.

## Provider abstraction

**Why this is the load-bearing design decision:** the gateway is a byte-transparent
reverse proxy — it doesn't parse or rewrite the request, only sniffs the response for
telemetry. That means it can front *any* provider's real endpoint. But each agent CLI
must be configured to *speak that provider's native wire format* itself; the gateway
cannot translate Anthropic Messages API calls into Gemini `generateContent` calls or vice
versa.

Two families of provider:

1. **OpenAI-wire-compatible**: OpenRouter, OpenAI, NVIDIA NIM, Zai, and Google's
   `/v1beta/openai/` compatibility layer. All speak the same Chat-Completions-shaped
   wire format the code already proxies for OpenRouter today. Wiring a new one in is the
   same pattern as the existing OpenRouter block: new base URL, new auth header.
2. **Native-only**: Anthropic's Messages API and Google's native Gemini API are distinct
   shapes. An agent can only reach them directly if it has its own built-in client for
   that shape.

`src/providers.ts` registry:

```ts
interface ProviderConfig {
  id: ProviderId;
  baseUrl: string;
  wireFormat: "openai-compat" | "anthropic-native" | "gemini-native";
  authHeader(key: string): Record<string, string>;
  credentialEnvVar: string;
  autohandConfigPath?: string[]; // fallback lookup in ~/.autohand/config.json
}
```

`resolveProviderCredential(provider)` generalizes today's
`resolveOpenRouterCredential`: check the provider's env var first, then the matching
section of `~/.autohand/config.json`, same pattern already used for OpenRouter.

**Capability matrix is verified against real agent source during implementation, not
assumed here.** What's known now:

- **Cline** documents native providers for OpenRouter, Anthropic, OpenAI, and Gemini —
  expected full support across all six registry providers (openai-compat ones via its
  generic/custom-endpoint provider mode).
- **Codex** (OpenAI's own CLI) only understands OpenAI-Chat/Responses-shaped wire format.
  It can reach OpenRouter, OpenAI, NVIDIA, Zai, and Google-via-compat-layer through the
  existing custom-`model_provider` override mechanism. It has **no** Anthropic-native or
  Gemini-native translator — `codex × anthropic` and `codex × google-native` report
  `blocked`. (`codex × google` via the OpenAI-compat layer is supported.)
- **Autohand**: `~/.autohand/config.json` has no bare `anthropic` section — Claude models
  currently route through Autohand's own hosted `autohandai` gateway (account auth, not a
  raw API key), which is out of scope for this benchmark's credential model. Confirmed
  config sections give `autohand × {openrouter, openai, nvidia, zai}`; `autohand ×
  anthropic` and `autohand × google` report `blocked` for v1 pending verification against
  the CLI's actual provider list at implementation time.
- **Pi**: confirmed custom-provider mechanism is OpenAI-compat only
  (`api: "openai-completions"` in today's code). Whether Pi has a first-class native
  Anthropic/Gemini client needs verification against Pi's own provider docs during
  implementation; treated as unverified, not assumed working.

Unsupported combinations throw a typed `UnsupportedCombinationError` in `adapters.ts`,
caught by the runner and turned into `status: "blocked"` with a specific reason — this
reuses the existing `RunStatus.blocked` path already used for missing CLIs, so no new
failure mode is introduced.

`gateway.ts`'s OpenRouter-specific response-cache guard (`X-OpenRouter-Cache: false`)
only applies when `provider === "openrouter"`; other providers don't have an equivalent
response-cache to guard against.

`telemetry.ts`'s generic key-scan already covers Anthropic (`cache_read_input_tokens`,
`cache_creation_input_tokens`) and OpenAI (`cached_tokens`,
`prompt_tokens_details.cached_tokens`) shapes without changes. It needs Gemini's key names
added: `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`,
`totalTokenCount`.

## Derived metrics

`src/metrics.ts`, pure functions over `TurnMeasurement`. Every field is `undefined` when
its inputs are missing — never estimated or fabricated, matching the existing
`CacheTelemetry` discipline.

| Metric | Formula |
|---|---|
| Total time | `elapsedMs` |
| TTFT | `firstByteMs` |
| Write speed (tok/s) | `outputTokens / ((elapsedMs - firstByteMs) / 1000)`, falling back to `outputTokens / (elapsedMs / 1000)` when `firstByteMs` is absent |
| Read speed (tok/s) | `inputTokens / (firstByteMs / 1000)` |
| Cache-read speed (tok/s) | `cacheReadTokens / (firstByteMs / 1000)` |
| Cache hit ratio | `cacheReadTokens / inputTokens` |
| Speedup | `cold.elapsedMs / warm.elapsedMs` (already exists on `PairClassification`, unchanged) |
| Cost | `costUsd` |

## Dashboard

`src/dashboard/data.ts` scans `results/run-*/report.json` (one run, or full history for
trend view) and groups turns by `(agent, provider, model)`, computing summary stats (mean,
median per metric) plus the round-level series needed for the step chart.

`src/dashboard/render.ts` takes that dataset and returns one self-contained HTML string:
inline CSS, a small vanilla-JS layer for tab switching, hand-rolled inline-SVG charts
(grouped bar + step/line with inline end labels) — no CDN dependency, no chart library, no
bundler. Chart palette/accessibility follows the `dataviz` skill.

Layout:
- Tabs to group by **Agent** or by **Provider**
- One bar-chart panel per metric: TTFT, write speed, read speed, cache hit rate, total
  time, cost
- Step/line chart for speedup: **round number** as X-axis for a single run (mirrors the
  screenshot's per-event granularity), **run date** as X-axis in "all runs" mode (trend/
  regression view across scheduled runs)
- Run picker: latest run vs. full history
- Collapsible raw-data table underneath for transparency

**Security requirement:** `render.ts` HTML-escapes every interpolated dynamic value
(model names, provider names, error messages) — these originate from provider API
responses and this page may be hosted where org members can view it, so no raw string
concatenation into the HTML output.

New CLI command: `bun run benchmark -- dashboard [--output <path>] [--all-runs]`.

## CI & distribution

Repo: **`autohandai/harnessperformance-benchmark`, private.** I will run `git init`,
commit, create the GitHub repo, and push only after this spec and the implementation plan
are reviewed — not automatically as part of writing code.

- `.github/workflows/ci.yml` — on every push/PR: `bun install && bun run proof`. No
  secrets required, safe on every commit.
- `.github/workflows/benchmark.yml` — scheduled (daily) + manual `workflow_dispatch` with
  agent/provider/model inputs. Runs `doctor` first (so the job log shows exactly what's
  usable given whichever of `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY`, `NVIDIA_API_KEY`, `ZAI_API_KEY` are configured as repo secrets — the
  rest gracefully report `blocked`), runs the live benchmark, then builds the dashboard
  and deploys via `actions/upload-pages-artifact` + `actions/deploy-pages`.

  `results/` is already in `.gitignore` — local runs are scratch output, not meant for
  version control, and this design keeps that convention on `main`. Instead, CI checks
  out a dedicated orphan `gh-pages` branch, appends the new run's `report.json` there
  (alongside all previously accumulated runs), rebuilds `dashboard/data.ts` over that
  branch's full history, and commits + pushes only `gh-pages`. `main` never receives
  generated data. `dashboard/data.ts` itself just takes a results-directory path, so it
  works identically against a local `results/` checkout or the `gh-pages` data checkout.
- Because the repo is private, GitHub Pages publishing requires the `autohandai` org to be
  on a plan that supports private-repo Pages (GitHub Team/Enterprise); if that publish
  step fails, the workflow falls back to uploading the built `dashboard.html` as a
  downloadable workflow artifact instead of failing the run.

**Known gap, not solved here:** the Autohand adapter points at a hardcoded local worktree
path (`AUTOHAND_BENCH_REPO`), which won't exist on a GitHub-hosted runner. Autohand will
report `blocked` in CI runs until that repo is checked out there too (its own step,
possibly needing a deploy key). Pi/Codex/Cline are unaffected.

## Testing

New, following the existing flat `bun:test` convention in `test/`:
- `test/metrics.test.ts` — derived-metric formulas, including missing-input edge cases
- `test/providers.test.ts` — registry lookup, credential resolution + env-var/config
  fallback per provider
- `test/dashboard.test.ts` — `data.ts` aggregation/grouping correctness; `render.ts`
  produces valid HTML, includes expected data points, and escapes untrusted strings

`bun run proof` gains a cheap regression check: build the dashboard over this repo's
existing committed sample `results/` and assert it doesn't throw.

## Rollout order

1. `metrics.ts` + provider-aware `types.ts`/`gateway.ts`/`providers.ts` — foundational, no
   UI, no new agent wiring, fully unit-testable against the existing schema-1 data.
2. `dashboard/` generator against the extended schema — visually verifiable locally
   immediately, no new credentials needed (works against existing results today).
3. Agent adapter provider-wiring in `adapters.ts`, tiered by confidence: OpenAI-compatible
   providers first (OpenAI, NVIDIA, Zai — live keys already available for two of these),
   then Anthropic/Google native per agent, verified against each agent's real source
   rather than assumed.
4. `git init`, CI workflows, GitHub repo + Pages — gated on explicit go-ahead before the
   first push.
