#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runControlRound } from "./control";
import { buildDashboardDataset, loadReports } from "./dashboard/data";
import { renderDashboard } from "./dashboard/render";
import { renderDoctor, runDoctor } from "./doctor";
import { isProviderId } from "./providers";
import { renderMarkdownReport } from "./report";
import { runBenchmark } from "./runner";
import { AGENT_IDS, type AgentId, type BenchmarkReport, PROVIDER_IDS, type ProviderId } from "./types";

interface ParsedOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseOptions(args: string[]): ParsedOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const equalsIndex = argument.indexOf("=");
    if (equalsIndex > 2) {
      values.set(argument.slice(2, equalsIndex), argument.slice(equalsIndex + 1));
      continue;
    }
    const name = argument.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { values, flags };
}

function positiveInteger(options: ParsedOptions, name: string, fallback: number): number {
  const raw = options.values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function selectedAgents(options: ParsedOptions): AgentId[] {
  const raw = options.values.get("agents");
  if (!raw) return [...AGENT_IDS];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !AGENT_IDS.includes(value as AgentId));
  if (invalid.length > 0) throw new Error(`Unknown agents: ${invalid.join(", ")}`);
  return values as AgentId[];
}

function selectedProviders(options: ParsedOptions): ProviderId[] {
  const raw = options.values.get("providers") ?? options.values.get("provider");
  if (!raw) return ["openrouter"];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !isProviderId(value));
  if (invalid.length > 0) {
    throw new Error(`Unknown providers: ${invalid.join(", ")} (known: ${PROVIDER_IDS.join(", ")})`);
  }
  return values as ProviderId[];
}

function help(): string {
  return `KV cache benchmark for OpenRouter-backed coding agents

Usage:
  bun run benchmark -- doctor [--json]
  bun run benchmark -- control [--provider openrouter] [--model openrouter/free] [--prefix-tokens 4096]
  bun run benchmark -- run [--agents autohand,pi,codex,cline] [--providers openrouter,nvidia] [options]
  bun run benchmark -- dashboard [--results results] [--output results/dashboard.html]

Options:
  --model <id>             Model id for the selected provider(s) (default: openrouter/free)
  --providers <list>       Providers to benchmark: ${PROVIDER_IDS.join(", ")} (default: openrouter)
  --prefix-tokens <n>      Estimated stable prefix size (default: 4096)
  --rounds <n>             Cold/warm pairs per agent (default: 1)
  --timeout-seconds <n>    Per-turn timeout (default: 180)
  --output <directory>     Artifact root for run; output file for dashboard (default: results)
  --results <directory>    Results directory the dashboard reads (default: results)
  --json                   Machine-readable doctor/control output

The run command performs live requests. It uses OPENROUTER_API_KEY when set, or the key already configured in ~/.autohand/config.json.`;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(help());
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor();
    console.log(options.flags.has("json") ? JSON.stringify(report, null, 2) : renderDoctor(report));
    return;
  }

  const model = options.values.get("model") ?? "openrouter/free";
  const targetPrefixTokens = positiveInteger(options, "prefix-tokens", 4_096);
  const timeoutMs = positiveInteger(options, "timeout-seconds", 180) * 1_000;
  if (command === "control") {
    const provider = selectedProviders(options)[0] ?? "openrouter";
    const round = await runControlRound({ provider, model, targetPrefixTokens, round: 1, timeoutMs });
    if (options.flags.has("json")) {
      console.log(JSON.stringify(round, null, 2));
    } else {
      const report: BenchmarkReport = {
        schemaVersion: 2,
        runId: `control-${Date.now()}`,
        createdAt: new Date().toISOString(),
        model,
        providers: [provider],
        targetPrefixTokens,
        rounds: 1,
        agents: [{ agent: "autohand", provider, status: "completed", rounds: [round] }],
      };
      console.log(renderMarkdownReport(report).replace("| autohand |", "| provider-control |"));
    }
    return;
  }
  if (command === "dashboard") {
    const resultsDir = options.values.get("results") ?? "results";
    const outputPath = resolve(options.values.get("output") ?? "results/dashboard.html");
    const runs = await loadReports(resultsDir);
    const html = renderDashboard(buildDashboardDataset(runs));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html);
    console.error(`Rendered ${runs.length} run(s) from ${resultsDir}`);
    console.log(outputPath);
    return;
  }
  if (command === "run") {
    const artifacts = await runBenchmark({
      agents: selectedAgents(options),
      providers: selectedProviders(options),
      model,
      targetPrefixTokens,
      rounds: positiveInteger(options, "rounds", 1),
      timeoutMs,
      outputRoot: options.values.get("output") ?? "results",
      onProgress: (message) => console.error(message),
    });
    console.log(artifacts.markdownPath);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${help()}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
