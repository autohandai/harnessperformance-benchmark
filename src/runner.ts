import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentRound } from "./adapters";
import { runDoctor } from "./doctor";
import { buildPromptPair } from "./prompt";
import { renderMarkdownReport } from "./report";
import type { AgentBenchmarkResult, AgentId, BenchmarkReport, ProviderId } from "./types";

export interface BenchmarkOptions {
  agents: AgentId[];
  providers: ProviderId[];
  model: string;
  rounds: number;
  targetPrefixTokens: number;
  timeoutMs: number;
  outputRoot: string;
  onProgress?: (message: string) => void;
}

export interface BenchmarkArtifacts {
  report: BenchmarkReport;
  directory: string;
  jsonPath: string;
  markdownPath: string;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkArtifacts> {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const directory = resolve(options.outputRoot, runId);
  await mkdir(directory, { recursive: true });
  const doctor = await runDoctor();
  const agents: AgentBenchmarkResult[] = [];

  for (const provider of options.providers) {
    for (const agent of options.agents) {
      const health = doctor.agents.find((entry) => entry.agent === agent);
      const label = `${agent} × ${provider}`;
      if (!health?.ready) {
        options.onProgress?.(`${label}: blocked — ${health?.reason ?? "doctor did not return a result"}`);
        agents.push({
          agent,
          provider,
          status: "blocked",
          rounds: [],
          ...(health?.version === undefined ? {} : { version: health.version }),
          error: health?.reason ?? "Agent health check failed.",
        });
        continue;
      }

      options.onProgress?.(`${label}: starting ${options.rounds} cold/warm round(s)`);
      const rounds = [];
      let error: string | undefined;
      for (let round = 1; round <= options.rounds; round += 1) {
        const prompt = buildPromptPair({ targetTokens: options.targetPrefixTokens, seed: `round-${round}` });
        try {
          const result = await runAgentRound({
            agent,
            provider,
            model: options.model,
            prompt,
            round,
            timeoutMs: options.timeoutMs,
          });
          rounds.push(result);
          options.onProgress?.(`${label}: round ${round} ${result.verdict} — ${result.reason}`);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          options.onProgress?.(`${label}: failed — ${error}`);
          break;
        }
      }
      const hasErrorRound = rounds.some((round) => round.verdict === "error");
      agents.push({
        agent,
        provider,
        status: error || hasErrorRound ? "failed" : "completed",
        rounds,
        ...(health.version === undefined ? {} : { version: health.version }),
        ...(error === undefined ? {} : { error }),
      });
    }
  }

  const report: BenchmarkReport = {
    schemaVersion: 2,
    runId,
    createdAt: new Date().toISOString(),
    model: options.model,
    providers: options.providers,
    targetPrefixTokens: options.targetPrefixTokens,
    rounds: options.rounds,
    agents,
  };
  const jsonPath = resolve(directory, "report.json");
  const markdownPath = resolve(directory, "report.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, renderMarkdownReport(report));
  return { report, directory, jsonPath, markdownPath };
}
