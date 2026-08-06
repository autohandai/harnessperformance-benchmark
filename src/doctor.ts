import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveOpenRouterCredential } from "./credentials";
import { runProcess } from "./process";
import { AGENT_IDS, type AgentId } from "./types";

export interface DoctorEntry {
  agent: AgentId;
  ready: boolean;
  command: string;
  version?: string;
  reason?: string;
}

export interface DoctorReport {
  openRouterCredential: boolean;
  agents: DoctorEntry[];
}

const DEFAULT_AUTOHAND_REPO = "/Users/igorcosta/Documents/autohand/cli-3-kv_cache_optimisations";

async function commandPath(command: string): Promise<string | undefined> {
  const result = await runProcess({
    command: ["/usr/bin/env", "which", command],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function inspectCommand(agent: Exclude<AgentId, "autohand">): Promise<DoctorEntry> {
  const executable = await commandPath(agent);
  if (!executable) return { agent, ready: false, command: agent, reason: "Executable not found on PATH." };

  const version = await runProcess({
    command: agent === "cline" ? [agent, "version"] : [agent, "--version"],
    cwd: process.cwd(),
    timeoutMs: 15_000,
  });
  const versionText = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/)[0];
  if (version.exitCode !== 0) {
    return {
      agent,
      ready: false,
      command: executable,
      ...(versionText ? { version: versionText } : {}),
      reason: `${agent} fails during startup: ${
        `${version.stderr}\n${version.stdout}`.match(/ERR_[A-Z_]+[^\n]*/)?.[0] ??
        `${version.stderr}\n${version.stdout}`.trim().split(/\r?\n/).at(-1) ??
        "unknown error"
      }`,
    };
  }

  if (agent === "cline") {
    const help = await runProcess({ command: [agent, "--help"], cwd: process.cwd(), timeoutMs: 15_000 });
    const output = `${help.stdout}\n${help.stderr}`;
    const missing = ["--provider", "--data-dir", "--json"].filter((flag) => !output.includes(flag));
    if (missing.length > 0) {
      return {
        agent,
        ready: false,
        command: executable,
        ...(versionText ? { version: versionText } : {}),
        reason: `Installed preview CLI lacks current headless flags: ${missing.join(", ")}.`,
      };
    }
  }

  return {
    agent,
    ready: true,
    command: executable,
    ...(versionText ? { version: versionText } : {}),
  };
}

async function inspectAutohand(): Promise<DoctorEntry> {
  const repo = process.env.AUTOHAND_BENCH_REPO ?? DEFAULT_AUTOHAND_REPO;
  try {
    await access(join(repo, "src/index.ts"));
  } catch {
    return {
      agent: "autohand",
      ready: false,
      command: `bun run ${join(repo, "src/index.ts")}`,
      reason: `KV-cache worktree not found at ${repo}.`,
    };
  }
  const version = await runProcess({
    command: ["bun", "run", "src/index.ts", "--version"],
    cwd: repo,
    env: { AUTOHAND_HOME: join(repo, ".benchmark-doctor-home") },
    timeoutMs: 30_000,
  });
  const versionText = `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/)[0];
  return {
    agent: "autohand",
    ready: version.exitCode === 0,
    command: `bun run ${join(repo, "src/index.ts")}`,
    ...(versionText ? { version: versionText } : {}),
    ...(version.exitCode === 0
      ? {}
      : { reason: `${version.stderr}\n${version.stdout}`.trim().split(/\r?\n/).at(-1) ?? "Startup failed." }),
  };
}

export async function runDoctor(): Promise<DoctorReport> {
  const [credential, entries] = await Promise.all([
    resolveOpenRouterCredential(),
    Promise.all([inspectAutohand(), inspectCommand("pi"), inspectCommand("codex"), inspectCommand("cline")]),
  ]);
  const byAgent = new Map(entries.map((entry) => [entry.agent, entry]));
  return {
    openRouterCredential: credential !== undefined,
    agents: AGENT_IDS.map((agent) => {
      const entry = byAgent.get(agent);
      if (!entry) throw new Error(`Doctor did not inspect ${agent}`);
      return entry;
    }),
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines = [`OpenRouter credential: ${report.openRouterCredential ? "available" : "missing"}`];
  for (const entry of report.agents) {
    lines.push(
      `${entry.ready ? "READY" : "BLOCKED"} ${entry.agent}${entry.version ? ` (${entry.version})` : ""}${entry.reason ? ` — ${entry.reason}` : ""}`,
    );
  }
  return lines.join("\n");
}
