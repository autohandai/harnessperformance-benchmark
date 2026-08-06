export const AGENT_IDS = ["autohand", "pi", "codex", "cline"] as const;

export type AgentId = (typeof AGENT_IDS)[number];
export type RunStatus = "completed" | "blocked" | "failed";
export type TurnStatus = "completed" | "failed" | "timeout";
export type CacheVerdict = "hit" | "miss" | "inconclusive" | "error";
export type TelemetrySource = "provider" | "agent" | "none";

export interface CacheTelemetry {
  generationId?: string;
  requestedModel?: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface TurnMeasurement extends CacheTelemetry {
  phase: "cold" | "warm";
  elapsedMs: number;
  firstByteMs?: number;
  status: TurnStatus;
  telemetrySource: TelemetrySource;
  providerStatusCode?: number;
  providerRequestCount?: number;
  error?: string;
}

export interface PairClassification {
  verdict: CacheVerdict;
  comparable: boolean;
  reason: string;
  speedup?: number;
  cacheReadRatio?: number;
}

export interface BenchmarkRound extends PairClassification {
  round: number;
  cold: TurnMeasurement;
  warm: TurnMeasurement;
}

export interface AgentBenchmarkResult {
  agent: AgentId;
  status: RunStatus;
  version?: string;
  rounds: BenchmarkRound[];
  error?: string;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  model: string;
  targetPrefixTokens: number;
  rounds: number;
  agents: AgentBenchmarkResult[];
}

export interface GatewayTrace extends CacheTelemetry {
  requestId: string;
  path: string;
  method: string;
  statusCode: number;
  startedAt: string;
  elapsedMs: number;
  firstByteMs?: number;
  hadSessionAffinity: boolean;
  responseCacheDisabled: true;
  error?: string;
}

export interface ProcessResult {
  command: string[];
  exitCode: number;
  elapsedMs: number;
  firstByteMs?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
