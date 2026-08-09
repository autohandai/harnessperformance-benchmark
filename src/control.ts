import { resolveOpenRouterCredential } from "./credentials";
import { startGateway } from "./gateway";
import { buildPromptPair } from "./prompt";
import { classifyPair } from "./telemetry";
import type { BenchmarkRound, GatewayTrace, TurnMeasurement } from "./types";

export interface ControlOptions {
  model: string;
  targetPrefixTokens: number;
  round: number;
  timeoutMs: number;
}

function measurement(phase: "cold" | "warm", elapsedMs: number, trace: GatewayTrace): TurnMeasurement {
  return {
    phase,
    provider: "openrouter",
    elapsedMs,
    status: trace.statusCode >= 200 && trace.statusCode < 300 ? "completed" : "failed",
    telemetrySource: "provider",
    providerStatusCode: trace.statusCode,
    ...(trace.firstByteMs === undefined ? {} : { firstByteMs: trace.firstByteMs }),
    ...(trace.requestedModel === undefined ? {} : { requestedModel: trace.requestedModel }),
    ...(trace.resolvedModel === undefined ? {} : { resolvedModel: trace.resolvedModel }),
    ...(trace.resolvedProvider === undefined ? {} : { resolvedProvider: trace.resolvedProvider }),
    ...(trace.generationId === undefined ? {} : { generationId: trace.generationId }),
    ...(trace.inputTokens === undefined ? {} : { inputTokens: trace.inputTokens }),
    ...(trace.outputTokens === undefined ? {} : { outputTokens: trace.outputTokens }),
    ...(trace.cacheReadTokens === undefined ? {} : { cacheReadTokens: trace.cacheReadTokens }),
    ...(trace.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: trace.cacheWriteTokens }),
    ...(trace.costUsd === undefined ? {} : { costUsd: trace.costUsd }),
    ...(trace.error === undefined ? {} : { error: trace.error }),
  };
}

export async function runControlRound(options: ControlOptions): Promise<BenchmarkRound> {
  const credential = await resolveOpenRouterCredential();
  if (!credential) throw new Error("An OpenRouter API key is required for a live benchmark");
  const prompt = buildPromptPair({
    targetTokens: options.targetPrefixTokens,
    seed: `control-${options.round}`,
  });
  const sessionId = `kv-cache-bench-${crypto.randomUUID()}`;
  const gateway = await startGateway();
  try {
    const execute = async (phase: "cold" | "warm", content: string): Promise<TurnMeasurement> => {
      const tracePromise = gateway.nextTrace(options.timeoutMs);
      const started = performance.now();
      const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.key}`,
          "content-type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content }],
          max_tokens: 24,
          temperature: 0,
          session_id: sessionId,
        }),
      });
      await response.arrayBuffer();
      const elapsedMs = performance.now() - started;
      const trace = await tracePromise;
      return measurement(phase, elapsedMs, trace);
    };
    const cold = await execute("cold", prompt.cold);
    const warm = await execute("warm", prompt.warm);
    return { round: options.round, cold, warm, ...classifyPair(cold, warm) };
  } finally {
    await gateway.close();
  }
}
