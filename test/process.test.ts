import { describe, expect, it } from "bun:test";
import { buildClineCommand } from "../src/adapters";
import { runProcess } from "../src/process";
import { buildPromptPair } from "../src/prompt";

describe("runProcess", () => {
  it("flushes piped stdin before closing the child stream", async () => {
    const result = await runProcess({
      command: ["bun", "-e", "process.stdin.on('data', c => process.stdout.write(c));"],
      cwd: process.cwd(),
      stdin: "warm prompt",
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("warm prompt");
  });
});

describe("Cline command construction", () => {
  it("uses complete prefixed prompts for independent cold and warm requests", () => {
    const prompt = buildPromptPair({ targetTokens: 256, seed: "cline-test" });
    const warm = buildClineCommand({
      dataDirectory: "/tmp/cline-data",
      model: "openrouter/free",
      prompt: prompt.warm,
      timeoutMs: 5_000,
      workspace: "/tmp/workspace",
    });

    expect(warm.at(-1)).toBe(prompt.warm);
    expect(warm).not.toContain("--id");
  });
});
