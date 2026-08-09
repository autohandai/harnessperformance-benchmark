import type { TurnMeasurement } from "./types";

/**
 * Throughput and timing metrics derived from a single turn's raw measurement.
 * Every field except `totalMs` is optional: it is present only when the inputs it
 * requires were actually captured. Missing values are never estimated or fabricated.
 */
export interface DerivedMetrics {
  totalMs: number;
  ttftMs?: number;
  /** Output tokens per second during the generation phase (after first byte). */
  writeTokensPerSecond?: number;
  /** Input tokens per second processed before the first byte (prefill throughput proxy). */
  readTokensPerSecond?: number;
  /** Cached input tokens served per second before the first byte. */
  cacheReadTokensPerSecond?: number;
  /** Fraction of input tokens served from cache, 0..1. */
  cacheHitRatio?: number;
}

const perSecond = (tokens: number, milliseconds: number): number | undefined =>
  milliseconds > 0 ? tokens / (milliseconds / 1000) : undefined;

export function deriveTurnMetrics(turn: TurnMeasurement): DerivedMetrics {
  const { elapsedMs, firstByteMs, inputTokens, outputTokens, cacheReadTokens } = turn;

  const metrics: DerivedMetrics = { totalMs: elapsedMs };
  if (firstByteMs !== undefined) metrics.ttftMs = firstByteMs;

  if (outputTokens !== undefined) {
    // Prefer the generation window (elapsed minus TTFT); fall back to total elapsed when
    // TTFT is unavailable or rounding makes the window non-positive.
    const generationMs =
      firstByteMs !== undefined && elapsedMs - firstByteMs > 0 ? elapsedMs - firstByteMs : elapsedMs;
    const writeSpeed = perSecond(outputTokens, generationMs);
    if (writeSpeed !== undefined) metrics.writeTokensPerSecond = writeSpeed;
  }

  if (firstByteMs !== undefined && inputTokens !== undefined) {
    const readSpeed = perSecond(inputTokens, firstByteMs);
    if (readSpeed !== undefined) metrics.readTokensPerSecond = readSpeed;
  }

  if (firstByteMs !== undefined && cacheReadTokens !== undefined) {
    const cacheSpeed = perSecond(cacheReadTokens, firstByteMs);
    if (cacheSpeed !== undefined) metrics.cacheReadTokensPerSecond = cacheSpeed;
  }

  if (inputTokens !== undefined && inputTokens > 0 && cacheReadTokens !== undefined) {
    metrics.cacheHitRatio = cacheReadTokens / inputTokens;
  }

  return metrics;
}
