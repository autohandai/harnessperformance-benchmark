import { afterEach, describe, expect, it } from "bun:test";
import { type Gateway, startGateway } from "../src/gateway";

const servers: Array<{ stop(force?: boolean): void }> = [];
const gateways: Gateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) server.stop(true);
});

describe("OpenRouterGateway", () => {
  it("forwards requests, disables response caching, and records cache telemetry", async () => {
    let authorization = "";
    let responseCache = "";
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? "";
        responseCache = request.headers.get("x-openrouter-cache") ?? "";
        return Response.json({
          id: "gen-test",
          model: "resolved/free",
          provider: "Fixture",
          usage: {
            prompt_tokens: 2_000,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 1_500 },
          },
          choices: [{ message: { role: "assistant", content: "ok" } }],
        });
      },
    });
    servers.push(upstream);

    const gateway = await startGateway({ upstreamBaseUrl: upstream.url.toString() });
    gateways.push(gateway);
    const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter/free", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    const trace = await gateway.nextTrace();

    expect(authorization).toBe("Bearer secret");
    expect(responseCache).toBe("false");
    expect(JSON.stringify(trace)).not.toContain("secret");
    expect(trace).toMatchObject({
      requestedModel: "openrouter/free",
      resolvedModel: "resolved/free",
      resolvedProvider: "Fixture",
      cacheReadTokens: 1_500,
      inputTokens: 2_000,
      statusCode: 200,
    });
    expect(trace.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not inject the OpenRouter response-cache header for other providers", async () => {
    let responseCache = "absent";
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        responseCache = request.headers.get("x-openrouter-cache") ?? "absent";
        return Response.json({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } });
      },
    });
    servers.push(upstream);
    const gateway = await startGateway({ provider: "anthropic", upstreamBaseUrl: upstream.url.toString() });
    gateways.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude" }),
    });
    await response.text();
    await gateway.nextTrace();
    expect(responseCache).toBe("absent");
  });

  it("captures a bounded upstream error without request credentials", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: { message: "unsupported tool schema" } }, { status: 400 });
      },
    });
    servers.push(upstream);
    const gateway = await startGateway({ upstreamBaseUrl: upstream.url.toString() });
    gateways.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter/free" }),
    });
    await response.text();
    const trace = await gateway.nextTrace();
    expect(trace.statusCode).toBe(400);
    expect(trace.error).toBe("unsupported tool schema");
    expect(JSON.stringify(trace)).not.toContain("secret");
  });
});
