import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutohandAuthToken, resolveOpenRouterCredential } from "../src/credentials";

describe("resolveOpenRouterCredential", () => {
  it("prefers an environment credential", async () => {
    const result = await resolveOpenRouterCredential({ OPENROUTER_API_KEY: "env-secret" }, "/missing");
    expect(result).toEqual({ key: "env-secret", source: "environment" });
  });

  it("reads an existing Autohand JSON config without exposing it in metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-test-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        auth: { token: "auth-secret" },
        openrouter: { apiKey: "configured-secret" },
      }),
    );
    try {
      const result = await resolveOpenRouterCredential({}, path);
      expect(result).toEqual({ key: "configured-secret", source: "autohand-config" });
      expect(JSON.stringify({ source: result?.source })).not.toContain("configured-secret");
      expect(await resolveAutohandAuthToken({}, path)).toBe("auth-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
