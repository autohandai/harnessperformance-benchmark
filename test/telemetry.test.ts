import { describe, expect, it } from "bun:test";
import { findAgentSessionId, isPiTurnEnd, measurementFromGatewayTraces } from "../src/adapters";
import { classifyPair, extractTelemetry } from "../src/telemetry";
import type { TurnMeasurement } from "../src/types";

describe("extractTelemetry", () => {
  it("normalizes OpenRouter chat-completions usage", () => {
    const telemetry = extractTelemetry({
      id: "gen-1",
      model: "provider/model:free",
      provider: "Example",
      usage: {
        prompt_tokens: 4_096,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 3_072, cache_write_tokens: 256 },
      },
    });

    expect(telemetry).toMatchObject({
      generationId: "gen-1",
      resolvedModel: "provider/model:free",
      resolvedProvider: "Example",
      inputTokens: 4_096,
      outputTokens: 12,
      cacheReadTokens: 3_072,
      cacheWriteTokens: 256,
    });
  });

  it("normalizes Codex and Pi usage dialects", () => {
    expect(
      extractTelemetry({
        type: "turn.completed",
        usage: { input_tokens: 9_000, cached_input_tokens: 8_000, output_tokens: 20 },
      }),
    ).toMatchObject({ inputTokens: 9_000, outputTokens: 20, cacheReadTokens: 8_000 });

    expect(
      extractTelemetry({
        type: "message_end",
        message: { usage: { input: 7_000, output: 10, cacheRead: 6_000, cacheWrite: 0 } },
      }),
    ).toMatchObject({ inputTokens: 7_000, outputTokens: 10, cacheReadTokens: 6_000 });
  });

  it("does not replace Cline usage with zero-valued model pricing", () => {
    const telemetry = extractTelemetry({
      type: "run_result",
      usage: {
        inputTokens: 7_190,
        outputTokens: 8,
        cacheReadTokens: 6_144,
        cacheWriteTokens: 0,
        totalCost: 0,
      },
      model: {
        id: "openrouter/free",
        provider: "openrouter",
        info: { pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
    });

    expect(telemetry).toMatchObject({
      inputTokens: 7_190,
      outputTokens: 8,
      cacheReadTokens: 6_144,
      cacheWriteTokens: 0,
      resolvedProvider: "openrouter",
    });
    expect(telemetry.generationId).toBeUndefined();
  });
});

describe("classifyPair", () => {
  const turn = (overrides: Partial<TurnMeasurement>): TurnMeasurement => ({
    phase: "cold",
    elapsedMs: 1_000,
    status: "completed",
    telemetrySource: "provider",
    ...overrides,
  });

  it("requires reported warm cached tokens for a hit", () => {
    const result = classifyPair(
      turn({ resolvedModel: "same", resolvedProvider: "same", cacheReadTokens: 0 }),
      turn({
        phase: "warm",
        elapsedMs: 500,
        resolvedModel: "same",
        resolvedProvider: "same",
        cacheReadTokens: 700,
        inputTokens: 1_000,
      }),
    );

    expect(result.verdict).toBe("hit");
    expect(result.speedup).toBe(2);
    expect(result.cacheReadRatio).toBe(0.7);
  });

  it("marks a free-router model change as incomparable", () => {
    const result = classifyPair(
      turn({ resolvedModel: "model-a", resolvedProvider: "A" }),
      turn({ phase: "warm", resolvedModel: "model-b", resolvedProvider: "B", cacheReadTokens: 100 }),
    );

    expect(result.verdict).toBe("inconclusive");
    expect(result.comparable).toBe(false);
    expect(result.reason).toMatch(/routing changed/i);
  });

  it("does not infer a cache hit from faster latency", () => {
    const result = classifyPair(
      turn({ elapsedMs: 5_000, resolvedModel: "same", resolvedProvider: "same" }),
      turn({ phase: "warm", elapsedMs: 100, resolvedModel: "same", resolvedProvider: "same" }),
    );

    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toMatch(/telemetry/i);
  });

  it("accepts cache telemetry but rejects a free-router latency comparison without route identity", () => {
    const result = classifyPair(
      turn({ requestedModel: "openrouter/free", resolvedModel: "openrouter/free", cacheReadTokens: 0 }),
      turn({
        phase: "warm",
        elapsedMs: 500,
        requestedModel: "openrouter/free",
        resolvedModel: "openrouter/free",
        cacheReadTokens: 700,
        inputTokens: 1_000,
      }),
    );

    expect(result.verdict).toBe("hit");
    expect(result.comparable).toBe(false);
    expect(result.speedup).toBeUndefined();
    expect(result.cacheReadRatio).toBe(0.7);
    expect(result.reason).toMatch(/route identity/i);
  });
});

describe("measurementFromGatewayTraces", () => {
  it("aggregates every request in an agent turn and exposes mixed routing", () => {
    const measurement = measurementFromGatewayTraces("cold", 2_000, [
      {
        requestId: "one",
        path: "/v1/chat/completions",
        method: "POST",
        statusCode: 200,
        startedAt: "2026-08-01T00:00:00.000Z",
        elapsedMs: 500,
        firstByteMs: 200,
        hadSessionAffinity: true,
        responseCacheDisabled: true,
        resolvedModel: "model-a",
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 0,
      },
      {
        requestId: "two",
        path: "/v1/chat/completions",
        method: "POST",
        statusCode: 200,
        startedAt: "2026-08-01T00:00:01.000Z",
        elapsedMs: 600,
        hadSessionAffinity: true,
        responseCacheDisabled: true,
        resolvedModel: "model-b",
        inputTokens: 120,
        outputTokens: 6,
        cacheReadTokens: 20,
      },
    ]);

    expect(measurement).toMatchObject({
      status: "completed",
      providerRequestCount: 2,
      resolvedModel: "mixed:model-a|model-b",
      inputTokens: 220,
      outputTokens: 11,
      cacheReadTokens: 20,
      firstByteMs: 200,
    });
  });
});

describe("Pi RPC turn attribution", () => {
  it("waits for agent_end so a late cold event cannot complete the warm turn", () => {
    expect(isPiTurnEnd({ type: "turn_end" })).toBe(false);
    expect(isPiTurnEnd({ type: "agent_end" })).toBe(true);
  });
});

describe("Cline session attribution", () => {
  it("accepts the taskId emitted by current Cline NDJSON", () => {
    expect(findAgentSessionId([{ type: "hook_event", taskId: "conv-123" }])).toBe("conv-123");
  });
});
