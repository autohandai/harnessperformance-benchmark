import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveTurnMetrics } from "../metrics";
import type { AgentId, ProviderId, RunStatus, TurnMeasurement } from "../types";

export interface DashboardRoundPoint {
  round: number;
  speedup: number | null;
  verdict: string;
}

export interface DashboardGroup {
  agent: AgentId;
  provider: ProviderId;
  model: string;
  status: RunStatus;
  roundCount: number;
  ttftMs?: number;
  writeTokensPerSecond?: number;
  readTokensPerSecond?: number;
  cacheReadTokensPerSecond?: number;
  cacheHitRate?: number;
  totalMs?: number;
  costUsd?: number;
  speedup?: number;
  rounds: DashboardRoundPoint[];
  error?: string;
}

export interface DashboardRun {
  runId: string;
  createdAt: string;
  model: string;
  providers: ProviderId[];
  groups: DashboardGroup[];
}

export interface DashboardDataset {
  generatedAt: string;
  runs: DashboardRun[];
}

/** Metric slots the UI draws as bars; kept here so data and render agree on identity. */
export const METRICS = [
  { key: "ttftMs", label: "Time to first token", unit: "ms", lowerIsBetter: true },
  { key: "writeTokensPerSecond", label: "Write speed", unit: "tok/s", lowerIsBetter: false },
  { key: "readTokensPerSecond", label: "Read speed", unit: "tok/s", lowerIsBetter: false },
  { key: "cacheReadTokensPerSecond", label: "Cache-read speed", unit: "tok/s", lowerIsBetter: false },
  { key: "cacheHitRate", label: "Cache hit rate", unit: "%", lowerIsBetter: false },
  { key: "totalMs", label: "Total time", unit: "ms", lowerIsBetter: true },
  { key: "costUsd", label: "Cost / round", unit: "$", lowerIsBetter: true },
  { key: "speedup", label: "Warm speedup", unit: "×", lowerIsBetter: false },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function mean(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (defined.length === 0) return undefined;
  return defined.reduce((total, value) => total + value, 0) / defined.length;
}

/** Read one turn defensively from either schema version, defaulting provider to openrouter. */
function readTurn(value: unknown, fallbackProvider: ProviderId): TurnMeasurement | undefined {
  if (!isObject(value)) return undefined;
  const provider = (typeof value.provider === "string" ? value.provider : fallbackProvider) as ProviderId;
  return { ...value, provider } as unknown as TurnMeasurement;
}

function summarizeGroup(
  agent: AgentId,
  provider: ProviderId,
  model: string,
  status: RunStatus,
  error: string | undefined,
  rawRounds: unknown[],
): DashboardGroup {
  const allTurns: TurnMeasurement[] = [];
  const warmTurns: TurnMeasurement[] = [];
  const roundCosts: Array<number | undefined> = [];
  const speedups: Array<number | undefined> = [];
  const rounds: DashboardRoundPoint[] = [];

  for (const raw of rawRounds) {
    if (!isObject(raw)) continue;
    const cold = readTurn(raw.cold, provider);
    const warm = readTurn(raw.warm, provider);
    for (const turn of [cold, warm]) if (turn) allTurns.push(turn);
    if (warm) warmTurns.push(warm);
    const speedup = typeof raw.speedup === "number" ? raw.speedup : undefined;
    speedups.push(speedup);
    roundCosts.push(
      cold?.costUsd !== undefined || warm?.costUsd !== undefined
        ? (cold?.costUsd ?? 0) + (warm?.costUsd ?? 0)
        : undefined,
    );
    rounds.push({
      round: typeof raw.round === "number" ? raw.round : rounds.length + 1,
      speedup: speedup ?? null,
      verdict: typeof raw.verdict === "string" ? raw.verdict : "unknown",
    });
  }

  const all = allTurns.map(deriveTurnMetrics);
  const warm = warmTurns.map(deriveTurnMetrics);

  const group: DashboardGroup = {
    agent,
    provider,
    model,
    status,
    roundCount: rawRounds.length,
    rounds,
  };
  const ttftMs = mean(all.map((metric) => metric.ttftMs));
  if (ttftMs !== undefined) group.ttftMs = ttftMs;
  const writeTokensPerSecond = mean(all.map((metric) => metric.writeTokensPerSecond));
  if (writeTokensPerSecond !== undefined) group.writeTokensPerSecond = writeTokensPerSecond;
  const readTokensPerSecond = mean(all.map((metric) => metric.readTokensPerSecond));
  if (readTokensPerSecond !== undefined) group.readTokensPerSecond = readTokensPerSecond;
  const totalMs = mean(all.map((metric) => metric.totalMs));
  if (totalMs !== undefined) group.totalMs = totalMs;
  const cacheReadTokensPerSecond = mean(warm.map((metric) => metric.cacheReadTokensPerSecond));
  if (cacheReadTokensPerSecond !== undefined) group.cacheReadTokensPerSecond = cacheReadTokensPerSecond;
  const cacheHitRatio = mean(warm.map((metric) => metric.cacheHitRatio));
  if (cacheHitRatio !== undefined) group.cacheHitRate = cacheHitRatio * 100;
  const costUsd = mean(roundCosts);
  if (costUsd !== undefined) group.costUsd = costUsd;
  const speedup = mean(speedups);
  if (speedup !== undefined) group.speedup = speedup;
  if (error !== undefined) group.error = error;
  return group;
}

export function summarizeReport(runId: string, report: unknown): DashboardRun | undefined {
  if (!isObject(report)) return undefined;
  const createdAt = typeof report.createdAt === "string" ? report.createdAt : new Date(0).toISOString();
  const model = typeof report.model === "string" ? report.model : "unknown";
  const agentsRaw = Array.isArray(report.agents) ? report.agents : [];
  const providerSet = new Set<ProviderId>();
  const groups: DashboardGroup[] = [];

  for (const entry of agentsRaw) {
    if (!isObject(entry)) continue;
    const agent = entry.agent as AgentId;
    const provider = (typeof entry.provider === "string" ? entry.provider : "openrouter") as ProviderId;
    const status = (typeof entry.status === "string" ? entry.status : "failed") as RunStatus;
    const error = typeof entry.error === "string" ? entry.error : undefined;
    const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
    providerSet.add(provider);
    groups.push(summarizeGroup(agent, provider, model, status, error, rounds));
  }

  const providers = Array.isArray(report.providers)
    ? (report.providers.filter((value) => typeof value === "string") as ProviderId[])
    : [...providerSet];

  return { runId, createdAt, model, providers, groups };
}

export async function loadReports(resultsDir: string): Promise<DashboardRun[]> {
  let entries: string[];
  try {
    entries = await readdir(resultsDir);
  } catch {
    return [];
  }
  const runs: DashboardRun[] = [];
  for (const entry of entries.filter((name) => name.startsWith("run-") || name.startsWith("control-"))) {
    try {
      const raw = await readFile(join(resultsDir, entry, "report.json"), "utf8");
      const run = summarizeReport(entry, JSON.parse(raw));
      if (run) runs.push(run);
    } catch {
      // Skip directories without a readable report.json.
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs;
}

export function buildDashboardDataset(runs: DashboardRun[]): DashboardDataset {
  return { generatedAt: new Date().toISOString(), runs };
}
