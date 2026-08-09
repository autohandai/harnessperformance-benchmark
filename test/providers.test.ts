import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, isProviderId, PROVIDERS, resolveProviderCredential } from "../src/providers";
import { PROVIDER_IDS } from "../src/types";

describe("provider registry", () => {
  it("defines a config for every provider id", () => {
    for (const id of PROVIDER_IDS) {
      const config = getProvider(id);
      expect(config.id).toBe(id);
      expect(config.baseUrl).toMatch(/^https:\/\//);
      expect(config.credentialEnvVars.length).toBeGreaterThan(0);
    }
  });

  it("uses bearer auth for OpenAI-compatible providers", () => {
    for (const id of ["openrouter", "openai", "nvidia", "zai"] as const) {
      expect(PROVIDERS[id].wireFormat).toBe("openai-compat");
      expect(PROVIDERS[id].authHeaders("k")).toEqual({ authorization: "Bearer k" });
    }
  });

  it("uses Anthropic-native auth headers", () => {
    expect(PROVIDERS.anthropic.wireFormat).toBe("anthropic-native");
    expect(PROVIDERS.anthropic.authHeaders("k")).toEqual({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
    });
  });

  it("uses Gemini-native auth and exposes an OpenAI-compatible base url", () => {
    expect(PROVIDERS.google.wireFormat).toBe("gemini-native");
    expect(PROVIDERS.google.authHeaders("k")).toEqual({ "x-goog-api-key": "k" });
    expect(PROVIDERS.google.openAiCompatibleBaseUrl).toContain("/openai");
  });

  it("recognizes valid provider ids", () => {
    expect(isProviderId("anthropic")).toBe(true);
    expect(isProviderId("bedrock")).toBe(false);
  });
});

describe("resolveProviderCredential", () => {
  it("prefers an environment credential", async () => {
    const result = await resolveProviderCredential(
      "anthropic",
      { ANTHROPIC_API_KEY: "env-secret" },
      "/missing",
    );
    expect(result).toEqual({ key: "env-secret", source: "environment" });
  });

  it("resolves Google from either GEMINI_API_KEY or GOOGLE_API_KEY", async () => {
    expect(await resolveProviderCredential("google", { GEMINI_API_KEY: "a" }, "/missing")).toEqual({
      key: "a",
      source: "environment",
    });
    expect(await resolveProviderCredential("google", { GOOGLE_API_KEY: "b" }, "/missing")).toEqual({
      key: "b",
      source: "environment",
    });
  });

  it("falls back to the matching Autohand config section", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-test-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ zai: { apiKey: "zai-secret" }, nvidia: { apiKey: "nv-secret" } }));
    try {
      expect(await resolveProviderCredential("zai", {}, path)).toEqual({
        key: "zai-secret",
        source: "autohand-config",
      });
      expect(await resolveProviderCredential("nvidia", {}, path)).toEqual({
        key: "nv-secret",
        source: "autohand-config",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns undefined when a provider has neither env nor config credential", async () => {
    expect(await resolveProviderCredential("anthropic", {}, "/missing")).toBeUndefined();
  });
});
