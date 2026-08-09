import { getProvider } from "./providers";
import { extractTelemetryFromText } from "./telemetry";
import type { GatewayTrace, ProviderId } from "./types";

export interface GatewayOptions {
  provider?: ProviderId;
  upstreamBaseUrl?: string;
  port?: number;
}

export interface Gateway {
  baseUrl: string;
  nextTrace(timeoutMs?: number): Promise<GatewayTrace>;
  takeTraces(): GatewayTrace[];
  close(): Promise<void>;
}

interface TraceWaiter {
  resolve(trace: GatewayTrace): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function targetUrl(upstreamBaseUrl: string, requestUrl: URL): URL {
  const base = upstreamBaseUrl.replace(/\/+$/, "");
  const path = requestUrl.pathname.replace(/^\/v1(?=\/)/, "");
  return new URL(`${base}${path}${requestUrl.search}`);
}

function safeResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return headers;
}

function upstreamError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown; message?: unknown };
    if (typeof parsed.error === "object" && parsed.error !== null) {
      const message = (parsed.error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Preserve only a bounded plain-text upstream error below.
  }
  const plain = text.replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 500) : `Upstream returned HTTP ${status}`;
}

export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const provider = options.provider ?? "openrouter";
  const upstreamBaseUrl = options.upstreamBaseUrl ?? getProvider(provider).baseUrl;
  const traces: GatewayTrace[] = [];
  const waiters: TraceWaiter[] = [];

  const publish = (trace: GatewayTrace): void => {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(trace);
      return;
    }
    traces.push(trace);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const started = performance.now();
      const startedAt = new Date().toISOString();
      const requestId = crypto.randomUUID();
      const incomingUrl = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      let requestBody: Record<string, unknown> | undefined;
      if (body && body.byteLength > 0) {
        try {
          requestBody = asObject(JSON.parse(new TextDecoder().decode(body)));
        } catch {
          requestBody = undefined;
        }
      }
      const requestedModel = typeof requestBody?.model === "string" ? requestBody.model : undefined;
      const sessionId = requestBody?.session_id;
      const promptCacheKey = requestBody?.prompt_cache_key;
      const hadSessionAffinity =
        (typeof sessionId === "string" && sessionId.length > 0) ||
        (typeof promptCacheKey === "string" && promptCacheKey.length > 0) ||
        Boolean(request.headers.get("x-session-id"));

      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      // OpenRouter has a separate identical-response cache that would masquerade as a
      // prompt-cache hit; disable it. Other providers have no such response cache.
      if (provider === "openrouter") headers.set("x-openrouter-cache", "false");

      try {
        const upstreamResponse = await fetch(targetUrl(upstreamBaseUrl, incomingUrl), {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: request.signal,
        });
        let firstByteMs: number | undefined;
        const chunks: Uint8Array[] = [];
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            if (!upstreamResponse.body) {
              const elapsedMs = performance.now() - started;
              publish({
                requestId,
                path: incomingUrl.pathname,
                method: request.method,
                statusCode: upstreamResponse.status,
                startedAt,
                elapsedMs,
                hadSessionAffinity,
                responseCacheDisabled: true,
                ...(requestedModel === undefined ? {} : { requestedModel }),
              });
              controller.close();
              return;
            }
            const reader = upstreamResponse.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                firstByteMs ??= performance.now() - started;
                chunks.push(value);
                controller.enqueue(value);
              }
              const responseText = new TextDecoder().decode(Buffer.concat(chunks));
              const telemetry = extractTelemetryFromText(responseText);
              const error = upstreamResponse.ok
                ? undefined
                : upstreamError(responseText, upstreamResponse.status);
              publish({
                requestId,
                path: incomingUrl.pathname,
                method: request.method,
                statusCode: upstreamResponse.status,
                startedAt,
                elapsedMs: performance.now() - started,
                hadSessionAffinity,
                responseCacheDisabled: true,
                ...(requestedModel === undefined ? {} : { requestedModel }),
                ...(firstByteMs === undefined ? {} : { firstByteMs }),
                ...telemetry,
                ...(error === undefined ? {} : { error }),
              });
              controller.close();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              publish({
                requestId,
                path: incomingUrl.pathname,
                method: request.method,
                statusCode: upstreamResponse.status,
                startedAt,
                elapsedMs: performance.now() - started,
                hadSessionAffinity,
                responseCacheDisabled: true,
                error: message,
                ...(requestedModel === undefined ? {} : { requestedModel }),
                ...(firstByteMs === undefined ? {} : { firstByteMs }),
              });
              controller.error(error);
            }
          },
        });

        return new Response(stream, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: safeResponseHeaders(upstreamResponse.headers),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({
          requestId,
          path: incomingUrl.pathname,
          method: request.method,
          statusCode: 502,
          startedAt,
          elapsedMs: performance.now() - started,
          hadSessionAffinity,
          responseCacheDisabled: true,
          error: message,
          ...(requestedModel === undefined ? {} : { requestedModel }),
        });
        return Response.json({ error: { message } }, { status: 502 });
      }
    },
  });

  return {
    baseUrl: new URL("v1", server.url).toString().replace(/\/$/, ""),
    nextTrace(timeoutMs = 120_000) {
      const trace = traces.shift();
      if (trace) return Promise.resolve(trace);
      return new Promise<GatewayTrace>((resolve, reject) => {
        const waiter: TraceWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting ${timeoutMs}ms for an OpenRouter trace`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    takeTraces() {
      return traces.splice(0);
    },
    async close() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Gateway closed before a trace arrived"));
      }
      await server.stop(true);
    },
  };
}
