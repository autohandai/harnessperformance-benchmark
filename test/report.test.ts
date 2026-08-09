import { describe, expect, it } from "bun:test";
import { renderMarkdownReport } from "../src/report";
import type { BenchmarkReport } from "../src/types";

describe("renderMarkdownReport", () => {
  it("keeps failures and inconclusive runs visible", () => {
    const report: BenchmarkReport = {
      schemaVersion: 2,
      runId: "run-test",
      createdAt: "2026-08-01T00:00:00.000Z",
      model: "openrouter/free",
      providers: ["openrouter"],
      targetPrefixTokens: 4_096,
      rounds: 1,
      agents: [
        {
          agent: "pi",
          provider: "openrouter",
          status: "blocked",
          version: "0.82.1",
          rounds: [],
          error: "startup dependency mismatch",
        },
      ],
    };

    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("pi");
    expect(markdown).toContain("blocked");
    expect(markdown).toContain("startup dependency mismatch");
  });
});
