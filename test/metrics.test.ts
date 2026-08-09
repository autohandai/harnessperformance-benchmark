import { describe, expect, it } from "bun:test";
import { deriveTurnMetrics } from "../src/metrics";
import type { TurnMeasurement } from "../src/types";

const turn = (overrides: Partial<TurnMeasurement>): TurnMeasurement => ({
  phase: "warm",
  provider: "openrouter",
  elapsedMs: 1_000,
  status: "completed",
  telemetrySource: "provider",
  ...overrides,
});

describe("deriveTurnMetrics", () => {
  it("computes all metrics from a fully populated turn", () => {
    const metrics = deriveTurnMetrics(
      turn({
        elapsedMs: 2_000,
        firstByteMs: 500,
        inputTokens: 1_000,
        outputTokens: 30,
        cacheReadTokens: 800,
      }),
    );

    expect(metrics.totalMs).toBe(2_000);
    expect(metrics.ttftMs).toBe(500);
    // 30 output tokens over the 1_500ms generation window = 20 tok/s
    expect(metrics.writeTokensPerSecond).toBeCloseTo(20, 6);
    // 1_000 input tokens over 500ms prefill = 2_000 tok/s
    expect(metrics.readTokensPerSecond).toBeCloseTo(2_000, 6);
    expect(metrics.cacheReadTokensPerSecond).toBeCloseTo(1_600, 6);
    expect(metrics.cacheHitRatio).toBeCloseTo(0.8, 6);
  });

  it("falls back to total elapsed for write speed when TTFT is absent", () => {
    const metrics = deriveTurnMetrics(turn({ elapsedMs: 1_000, outputTokens: 50 }));
    expect(metrics.ttftMs).toBeUndefined();
    expect(metrics.readTokensPerSecond).toBeUndefined();
    // 50 tokens over the full 1_000ms = 50 tok/s
    expect(metrics.writeTokensPerSecond).toBeCloseTo(50, 6);
  });

  it("does not produce a negative window when TTFT >= elapsed", () => {
    const metrics = deriveTurnMetrics(turn({ elapsedMs: 400, firstByteMs: 400, outputTokens: 4 }));
    // window collapses to elapsed: 4 tokens / 0.4s = 10 tok/s, never negative
    expect(metrics.writeTokensPerSecond).toBeCloseTo(10, 6);
  });

  it("leaves throughput undefined when token counts are missing", () => {
    const metrics = deriveTurnMetrics(turn({ firstByteMs: 500 }));
    expect(metrics.writeTokensPerSecond).toBeUndefined();
    expect(metrics.readTokensPerSecond).toBeUndefined();
    expect(metrics.cacheHitRatio).toBeUndefined();
  });

  it("treats zero cached tokens as a 0 hit ratio, not undefined", () => {
    const metrics = deriveTurnMetrics(turn({ firstByteMs: 500, inputTokens: 1_000, cacheReadTokens: 0 }));
    expect(metrics.cacheHitRatio).toBe(0);
    expect(metrics.cacheReadTokensPerSecond).toBe(0);
  });

  it("avoids division by zero when inputTokens is zero", () => {
    const metrics = deriveTurnMetrics(turn({ firstByteMs: 500, inputTokens: 0, cacheReadTokens: 0 }));
    expect(metrics.cacheHitRatio).toBeUndefined();
    expect(metrics.readTokensPerSecond).toBe(0);
  });
});
