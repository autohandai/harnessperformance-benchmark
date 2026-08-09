import { describe, expect, it } from "bun:test";
import { type DoctorReport, renderDoctor, resolveProviderCredentials } from "../src/doctor";
import { PROVIDER_IDS } from "../src/types";

describe("renderDoctor", () => {
  it("lists available and missing provider credentials", () => {
    const report: DoctorReport = {
      providers: [
        { provider: "openrouter", credential: true },
        { provider: "anthropic", credential: false },
        { provider: "nvidia", credential: true },
      ],
      agents: [{ agent: "pi", ready: true, command: "pi", version: "0.83.0" }],
    };
    const text = renderDoctor(report);
    expect(text).toContain("available: openrouter, nvidia");
    expect(text).toContain("missing: anthropic");
    expect(text).toContain("READY pi");
  });
});

describe("resolveProviderCredentials", () => {
  it("reports a credential status for every known provider", async () => {
    const statuses = await resolveProviderCredentials();
    expect(statuses.map((entry) => entry.provider).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const entry of statuses) expect(typeof entry.credential).toBe("boolean");
  });
});
