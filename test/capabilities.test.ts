import { describe, expect, it } from "bun:test";
import { assertSupported, capabilityFor, UnsupportedCombinationError } from "../src/capabilities";
import { AGENT_IDS } from "../src/types";

describe("capabilityFor", () => {
  it("supports OpenAI-compatible providers for every gateway-routed agent", () => {
    for (const agent of AGENT_IDS) {
      for (const provider of ["openrouter", "openai", "nvidia", "zai"] as const) {
        if (agent === "cline" && provider !== "openrouter") continue;
        expect(capabilityFor(agent, provider).supported).toBe(true);
      }
    }
  });

  it("supports Google via its OpenAI-compatible layer for gateway-routed agents", () => {
    expect(capabilityFor("pi", "google").supported).toBe(true);
    expect(capabilityFor("codex", "google").supported).toBe(true);
  });

  it("blocks Anthropic because only its native wire exists", () => {
    const capability = capabilityFor("pi", "anthropic");
    expect(capability.supported).toBe(false);
    expect(capability.reason).toMatch(/native/i);
  });

  it("blocks Cline against any non-OpenRouter provider", () => {
    expect(capabilityFor("cline", "nvidia").supported).toBe(false);
    expect(capabilityFor("cline", "openrouter").supported).toBe(true);
  });

  it("assertSupported throws a typed error for unsupported combinations", () => {
    expect(() => assertSupported("codex", "anthropic")).toThrow(UnsupportedCombinationError);
    expect(() => assertSupported("codex", "openrouter")).not.toThrow();
  });
});
