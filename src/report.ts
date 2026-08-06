import type { BenchmarkReport } from "./types";

function formatNumber(value: number | undefined, digits = 0): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

export function renderMarkdownReport(report: BenchmarkReport): string {
  const lines = [
    "# KV cache benchmark",
    "",
    `- Run: \`${report.runId}\``,
    `- Created: ${report.createdAt}`,
    `- Requested model: \`${report.model}\``,
    `- Target stable prefix: ${report.targetPrefixTokens.toLocaleString()} estimated tokens`,
    `- Rounds: ${report.rounds}`,
    "",
    "| Agent | Status | Cache result | Warm cached tokens | Speedup | Detail |",
    "| --- | --- | --- | ---: | ---: | --- |",
  ];

  for (const agent of report.agents) {
    if (agent.rounds.length === 0) {
      lines.push(
        `| ${agent.agent} | ${agent.status} | — | — | — | ${agent.error ?? "No completed rounds"} |`,
      );
      continue;
    }
    for (const round of agent.rounds) {
      const speedup = round.speedup === undefined ? "—" : `${formatNumber(round.speedup, 2)}x`;
      lines.push(
        `| ${agent.agent} | ${agent.status} | ${round.verdict} | ${formatNumber(round.warm.cacheReadTokens)} | ${speedup} | ${round.reason} |`,
      );
    }
  }

  lines.push(
    "",
    "A hit is recorded only when the warm turn reports cached input tokens greater than zero. " +
      "Latency improvements without cache telemetry remain inconclusive. Routed model/provider changes are not compared.",
    "",
  );
  return lines.join("\n");
}
