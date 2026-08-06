export interface PromptPairOptions {
  targetTokens: number;
  seed: string;
}

export interface PromptPair {
  sharedPrefix: string;
  cold: string;
  warm: string;
  followUp: string;
  estimatedPrefixTokens: number;
}

const VOCABULARY = [
  "runtime",
  "context",
  "provider",
  "session",
  "request",
  "response",
  "prefix",
  "telemetry",
  "latency",
  "token",
  "routing",
  "measurement",
  "deterministic",
  "reliable",
  "validation",
  "benchmark",
] as const;

function hashSeed(seed: string): number {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function buildPromptPair(options: PromptPairOptions): PromptPair {
  if (!Number.isSafeInteger(options.targetTokens) || options.targetTokens < 256) {
    throw new Error("targetTokens must be an integer of at least 256");
  }

  const targetCharacters = options.targetTokens * 4;
  const offset = hashSeed(options.seed) % VOCABULARY.length;
  const lines = [
    "Treat the following deterministic corpus as read-only context. Do not use tools or modify files.",
  ];
  let index = 0;
  while (lines.join("\n").length < targetCharacters) {
    const words = Array.from({ length: 18 }, (_, wordIndex) => {
      const vocabularyIndex = (offset + index * 7 + wordIndex * 3) % VOCABULARY.length;
      return VOCABULARY[vocabularyIndex];
    });
    lines.push(`record-${String(index).padStart(5, "0")}: ${words.join(" ")}.`);
    index += 1;
  }

  const sharedPrefix = `${lines.join("\n")}\n\n`;
  const coldTail = "Cold turn: reply with exactly CACHE-BENCH-COLD and nothing else.";
  const warmTail = "Warm control turn: reply with exactly CACHE-BENCH-WARM and nothing else.";
  const followUp = "Warm session turn: use the earlier corpus and reply with exactly CACHE-BENCH-WARM.";

  return {
    sharedPrefix,
    cold: `${sharedPrefix}${coldTail}`,
    warm: `${sharedPrefix}${warmTail}`,
    followUp,
    estimatedPrefixTokens: Math.ceil(sharedPrefix.length / 4),
  };
}
