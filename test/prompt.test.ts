import { describe, expect, it } from "bun:test";
import { buildPromptPair } from "../src/prompt";

describe("buildPromptPair", () => {
  it("creates a deterministic shared prefix and distinct turn tails", () => {
    const first = buildPromptPair({ targetTokens: 2_048, seed: "stable" });
    const second = buildPromptPair({ targetTokens: 2_048, seed: "stable" });

    expect(first).toEqual(second);
    expect(first.cold).not.toEqual(first.warm);
    expect(first.cold.startsWith(first.sharedPrefix)).toBe(true);
    expect(first.warm.startsWith(first.sharedPrefix)).toBe(true);
    expect(first.estimatedPrefixTokens).toBeGreaterThanOrEqual(2_048);
  });
});
