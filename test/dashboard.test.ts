import { describe, expect, it } from "bun:test";
import { buildDashboardDataset, summarizeReport } from "../src/dashboard/data";
import { renderDashboard } from "../src/dashboard/render";
import type { BenchmarkReport, TurnMeasurement } from "../src/types";

const turn = (over: Partial<TurnMeasurement>): TurnMeasurement => ({
  phase: "cold",
  provider: "openrouter",
  elapsedMs: 1_000,
  status: "completed",
  telemetrySource: "provider",
  ...over,
});

const sampleReport = (): BenchmarkReport => ({
  schemaVersion: 2,
  runId: "run-a",
  createdAt: "2026-08-10T12:00:00.000Z",
  model: "prov/model",
  providers: ["openrouter"],
  targetPrefixTokens: 4_096,
  rounds: 1,
  agents: [
    {
      agent: "pi",
      provider: "openrouter",
      status: "completed",
      rounds: [
        {
          round: 1,
          verdict: "hit",
          comparable: true,
          reason: "hit",
          speedup: 2,
          cold: turn({
            phase: "cold",
            elapsedMs: 2_000,
            firstByteMs: 500,
            inputTokens: 1_000,
            outputTokens: 40,
            cacheReadTokens: 0,
            costUsd: 0.01,
          }),
          warm: turn({
            phase: "warm",
            elapsedMs: 1_000,
            firstByteMs: 200,
            inputTokens: 1_000,
            outputTokens: 40,
            cacheReadTokens: 800,
            costUsd: 0.002,
          }),
        },
      ],
    },
  ],
});

describe("summarizeReport", () => {
  it("aggregates derived metrics across a round's cold and warm turns", () => {
    const run = summarizeReport("run-a", sampleReport());
    expect(run).toBeDefined();
    const group = run?.groups[0];
    expect(group?.agent).toBe("pi");
    expect(group?.provider).toBe("openrouter");
    expect(group?.ttftMs).toBeCloseTo(350, 4); // mean(500, 200)
    expect(group?.writeTokensPerSecond).toBeCloseTo((40 / 1.5 + 50) / 2, 4);
    expect(group?.readTokensPerSecond).toBeCloseTo(3_500, 4); // mean(2000, 5000)
    expect(group?.cacheReadTokensPerSecond).toBeCloseTo(4_000, 4); // warm only
    expect(group?.cacheHitRate).toBeCloseTo(80, 4); // warm ratio 0.8 -> 80%
    expect(group?.totalMs).toBeCloseTo(1_500, 4);
    expect(group?.costUsd).toBeCloseTo(0.012, 6);
    expect(group?.speedup).toBeCloseTo(2, 6);
  });

  it("defaults provider to openrouter for schema-1 reports", () => {
    const legacy = {
      schemaVersion: 1,
      runId: "run-old",
      createdAt: "2026-08-01T00:00:00.000Z",
      model: "openrouter/free",
      targetPrefixTokens: 4_096,
      rounds: 1,
      agents: [
        {
          agent: "codex",
          status: "completed",
          rounds: [
            {
              round: 1,
              verdict: "miss",
              comparable: true,
              reason: "x",
              speedup: 1,
              cold: { phase: "cold", elapsedMs: 100 },
              warm: { phase: "warm", elapsedMs: 100 },
            },
          ],
        },
      ],
    };
    const run = summarizeReport("run-old", legacy);
    expect(run?.groups[0]?.provider).toBe("openrouter");
  });
});

describe("renderDashboard", () => {
  it("produces a self-contained page with an escaped JSON island", () => {
    const html = renderDashboard(buildDashboardDataset([summarizeReport("run-a", sampleReport())!]));
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Harness Performance Benchmark</title>");
    // Self-contained: no external resource loads (CDN scripts, remote fonts/images).
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/src=["']https?:/);
    const island = html.match(/<script id="bench-data" type="application\/json">([\s\S]*?)<\/script>/);
    expect(island).not.toBeNull();
    expect(JSON.parse(island![1] as string).runs).toHaveLength(1);
  });

  it("escapes markup embedded in untrusted model/provider strings", () => {
    const evil = summarizeReport("run-evil", {
      ...sampleReport(),
      model: "</script><img src=x onerror=alert(1)>",
    })!;
    const html = renderDashboard(buildDashboardDataset([evil]));
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script>");
  });

  it("runs the embedded chart app against a DOM shim without throwing", () => {
    const html = renderDashboard(buildDashboardDataset([summarizeReport("run-a", sampleReport())!]));
    const appScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).at(-1);
    expect(appScript).toBeTruthy();
    const islandJson = html.match(
      /<script id="bench-data" type="application\/json">([\s\S]*?)<\/script>/,
    )![1];

    const created: Array<{ tag: string }> = [];
    const makeNode = (tag: string): Record<string, unknown> => {
      const node: Record<string, unknown> = {
        tag,
        children: [] as unknown[],
        style: {},
        _attrs: {} as Record<string, string>,
        set textContent(v: unknown) {},
        get textContent() {
          return tag === "bench-data" ? islandJson : "";
        },
        set innerHTML(_v: unknown) {},
        appendChild(child: unknown) {
          (node.children as unknown[]).push(child);
          return child;
        },
        setAttribute(k: string, v: string) {
          (node._attrs as Record<string, string>)[k] = v;
        },
        getAttribute(k: string) {
          return (node._attrs as Record<string, string>)[k] ?? null;
        },
        addEventListener() {},
        querySelectorAll() {
          return [];
        },
      };
      created.push({ tag });
      return node;
    };

    const byId: Record<string, Record<string, unknown>> = {
      "bench-data": makeNode("bench-data"),
      "bar-grid": makeNode("div"),
      legend: makeNode("div"),
      "step-plot": makeNode("div"),
      "table-host": makeNode("div"),
      "run-select": makeNode("select"),
    };
    const doc = {
      getElementById: (id: string) => byId[id] ?? makeNode("div"),
      createElement: (tag: string) => makeNode(tag),
      createElementNS: (_ns: string, tag: string) => makeNode(tag),
      querySelectorAll: () => [],
      body: makeNode("body"),
    };
    const sandbox = {
      document: doc,
      getComputedStyle: () => ({ getPropertyValue: () => "#123456" }),
      parseInt,
      parseFloat,
      isFinite,
      Math,
      Object,
      Array,
      JSON,
      String,
    };
    const runApp = new Function(...Object.keys(sandbox), appScript as string);
    expect(() => runApp(...Object.values(sandbox))).not.toThrow();
    // The app should have created SVG marks (rects for bars, path for the step chart).
    expect(created.some((n) => n.tag === "rect")).toBe(true);
    expect(created.some((n) => n.tag === "path")).toBe(true);
  });
});
