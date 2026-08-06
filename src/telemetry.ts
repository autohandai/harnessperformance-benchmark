import type { CacheTelemetry, PairClassification, TurnMeasurement } from "./types";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function visit(value: unknown, callback: (object: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!isObject(value)) return;
  callback(value);
  for (const nested of Object.values(value)) visit(nested, callback);
}

function firstString(value: unknown, keys: readonly string[]): string | undefined {
  let result: string | undefined;
  visit(value, (object) => {
    if (result !== undefined) return;
    for (const key of keys) {
      const candidate = object[key];
      if (typeof candidate === "string" && candidate.trim()) {
        result = candidate;
        return;
      }
    }
  });
  return result;
}

function firstGenerationId(value: unknown): string | undefined {
  let result: string | undefined;
  visit(value, (object) => {
    if (result !== undefined) return;
    const candidate = object.id;
    if (typeof candidate === "string" && candidate.startsWith("gen-")) result = candidate;
  });
  return result;
}

function lastNumber(value: unknown, keys: readonly string[]): number | undefined {
  let result: number | undefined;
  visit(value, (object) => {
    for (const key of keys) {
      const candidate = object[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
        result = candidate;
      }
    }
  });
  return result;
}

function lastUsageNumber(value: unknown, keys: readonly string[]): number | undefined {
  let result: number | undefined;
  const inspect = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) inspect(item);
      return;
    }
    const object = isObject(candidate) ? candidate : undefined;
    if (!object) return;
    for (const [key, nested] of Object.entries(object)) {
      if ((key === "usage" || key === "aggregateUsage") && isObject(nested)) {
        for (const metric of keys) {
          const number = nested[metric];
          if (typeof number === "number" && Number.isFinite(number) && number >= 0) result = number;
        }
      }
      inspect(nested);
    }
  };
  inspect(value);
  return result;
}

export function extractTelemetry(value: unknown): CacheTelemetry {
  const generationId = firstString(value, ["generation_id", "generationId"]) ?? firstGenerationId(value);
  const resolvedModel = firstString(value, ["resolved_model", "resolvedModel", "model"]);
  const resolvedProvider = firstString(value, [
    "provider_name",
    "providerName",
    "resolved_provider",
    "resolvedProvider",
    "provider",
  ]);
  const inputTokens =
    lastNumber(value, [
      "native_tokens_prompt",
      "prompt_tokens",
      "input_tokens",
      "inputTokens",
      "totalInputTokens",
    ]) ?? lastUsageNumber(value, ["input"]);
  const outputTokens =
    lastNumber(value, [
      "native_tokens_completion",
      "completion_tokens",
      "output_tokens",
      "outputTokens",
      "totalOutputTokens",
    ]) ?? lastUsageNumber(value, ["output"]);
  const cacheReadTokens =
    lastNumber(value, [
      "native_tokens_cached",
      "cached_input_tokens",
      "cached_tokens",
      "cache_read_input_tokens",
      "cacheReadTokens",
    ]) ?? lastUsageNumber(value, ["cacheRead"]);
  const cacheWriteTokens =
    lastNumber(value, [
      "cache_write_tokens",
      "cache_creation_input_tokens",
      "cache_write_input_tokens",
      "cacheWriteTokens",
    ]) ?? lastUsageNumber(value, ["cacheWrite"]);
  const costUsd =
    lastNumber(value, ["total_cost", "cost_usd", "costUsd", "totalCost"]) ?? lastUsageNumber(value, ["cost"]);

  return {
    ...(generationId === undefined ? {} : { generationId }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(resolvedProvider === undefined ? {} : { resolvedProvider }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export function extractTelemetryFromText(text: string): CacheTelemetry {
  let merged: CacheTelemetry = {};
  const records: unknown[] = [];
  try {
    records.push(JSON.parse(text));
  } catch {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.startsWith("data:") ? rawLine.slice(5).trim() : rawLine.trim();
      if (!line || line === "[DONE]") continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Human-readable agent output is intentionally ignored.
      }
    }
  }

  for (const record of records) {
    merged = { ...merged, ...extractTelemetry(record) };
  }
  return merged;
}

export function classifyPair(cold: TurnMeasurement, warm: TurnMeasurement): PairClassification {
  if (cold.status !== "completed" || warm.status !== "completed") {
    return {
      verdict: "error",
      comparable: false,
      reason: cold.error ?? warm.error ?? "At least one turn did not complete.",
    };
  }

  const modelChanged = Boolean(
    cold.resolvedModel && warm.resolvedModel && cold.resolvedModel !== warm.resolvedModel,
  );
  const providerChanged = Boolean(
    cold.resolvedProvider && warm.resolvedProvider && cold.resolvedProvider !== warm.resolvedProvider,
  );
  if (modelChanged || providerChanged) {
    return {
      verdict: "inconclusive",
      comparable: false,
      reason: "OpenRouter routing changed between the cold and warm turns.",
    };
  }

  const freeRouterRequested =
    cold.requestedModel === "openrouter/free" || warm.requestedModel === "openrouter/free";
  const freeRouterIdentityUnavailable =
    freeRouterRequested &&
    (!cold.resolvedModel ||
      !warm.resolvedModel ||
      cold.resolvedModel === "openrouter/free" ||
      warm.resolvedModel === "openrouter/free");

  const speedup = warm.elapsedMs > 0 ? cold.elapsedMs / warm.elapsedMs : undefined;
  const cacheReadRatio =
    warm.cacheReadTokens !== undefined && warm.inputTokens !== undefined && warm.inputTokens > 0
      ? warm.cacheReadTokens / warm.inputTokens
      : undefined;
  const metrics = {
    ...(speedup === undefined ? {} : { speedup }),
    ...(cacheReadRatio === undefined ? {} : { cacheReadRatio }),
  };

  if (warm.cacheReadTokens === undefined) {
    return {
      verdict: "inconclusive",
      comparable: !freeRouterIdentityUnavailable,
      reason: freeRouterIdentityUnavailable
        ? "The warm turn exposed neither cache telemetry nor the free router's resolved route identity."
        : "The warm turn did not expose provider or agent cache telemetry.",
      ...(freeRouterIdentityUnavailable ? {} : metrics),
    };
  }
  if (warm.cacheReadTokens > 0) {
    return {
      verdict: "hit",
      comparable: !freeRouterIdentityUnavailable,
      reason: freeRouterIdentityUnavailable
        ? `The warm turn reported ${warm.cacheReadTokens} cached input tokens, but latency is incomparable because the free router's resolved route identity is unavailable.`
        : `The warm turn reported ${warm.cacheReadTokens} cached input tokens.`,
      ...(freeRouterIdentityUnavailable ? (cacheReadRatio === undefined ? {} : { cacheReadRatio }) : metrics),
    };
  }
  return {
    verdict: "miss",
    comparable: !freeRouterIdentityUnavailable,
    reason: freeRouterIdentityUnavailable
      ? "The warm turn explicitly reported zero cached input tokens, but latency is incomparable because the free router's resolved route identity is unavailable."
      : "The warm turn explicitly reported zero cached input tokens.",
    ...(freeRouterIdentityUnavailable ? {} : metrics),
  };
}
