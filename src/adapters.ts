import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAutohandAuthToken, resolveOpenRouterCredential } from "./credentials";
import { type Gateway, startGateway } from "./gateway";
import { conciseProcessError, runProcess } from "./process";
import type { PromptPair } from "./prompt";
import { classifyPair, extractTelemetry, extractTelemetryFromText } from "./telemetry";
import type {
  AgentId,
  BenchmarkRound,
  CacheTelemetry,
  GatewayTrace,
  ProcessResult,
  ProviderId,
  TurnMeasurement,
} from "./types";

export interface AgentRoundOptions {
  agent: AgentId;
  provider: ProviderId;
  model: string;
  prompt: PromptPair;
  round: number;
  timeoutMs: number;
}

const AUTOHAND_REPO =
  process.env.AUTOHAND_BENCH_REPO ?? "/Users/igorcosta/Documents/autohand/cli-3-kv_cache_optimisations";

function sumWhenComplete(
  traces: GatewayTrace[],
  field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "costUsd",
): number | undefined {
  const values = traces.map((trace) => trace[field]);
  return values.every((value): value is number => value !== undefined)
    ? values.reduce((total, value) => total + value, 0)
    : undefined;
}

function consistentValue(
  traces: GatewayTrace[],
  field: "requestedModel" | "resolvedModel" | "resolvedProvider",
): string | undefined {
  const values = [
    ...new Set(traces.map((trace) => trace[field]).filter((value): value is string => Boolean(value))),
  ];
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : `mixed:${values.join("|")}`;
}

export function measurementFromGatewayTraces(
  phase: "cold" | "warm",
  provider: ProviderId,
  elapsedMs: number,
  traces: GatewayTrace[],
): TurnMeasurement {
  const trace = traces.at(-1);
  if (!trace) {
    return {
      phase,
      provider,
      elapsedMs,
      status: "failed",
      telemetrySource: "none",
      error: "The agent turn completed without a captured provider request.",
    };
  }
  const failedTrace = traces.find(
    (candidate) => candidate.statusCode < 200 || candidate.statusCode >= 300 || candidate.error !== undefined,
  );
  const successful = failedTrace === undefined;
  const requestedModel = consistentValue(traces, "requestedModel");
  const resolvedModel = consistentValue(traces, "resolvedModel");
  const resolvedProvider = consistentValue(traces, "resolvedProvider");
  const inputTokens = sumWhenComplete(traces, "inputTokens");
  const outputTokens = sumWhenComplete(traces, "outputTokens");
  const cacheReadTokens = sumWhenComplete(traces, "cacheReadTokens");
  const cacheWriteTokens = sumWhenComplete(traces, "cacheWriteTokens");
  const costUsd = sumWhenComplete(traces, "costUsd");
  return {
    phase,
    provider,
    elapsedMs,
    status: successful ? "completed" : "failed",
    telemetrySource: "provider",
    providerStatusCode: failedTrace?.statusCode ?? trace.statusCode,
    providerRequestCount: traces.length,
    ...(traces[0]?.firstByteMs === undefined ? {} : { firstByteMs: traces[0].firstByteMs }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
    ...(resolvedProvider === undefined ? {} : { resolvedProvider }),
    ...(trace.generationId === undefined ? {} : { generationId: trace.generationId }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(failedTrace?.error === undefined ? {} : { error: failedTrace.error }),
  };
}

async function completedTurnTraces(gateway: Gateway, timeoutMs: number): Promise<GatewayTrace[]> {
  const captured = gateway.takeTraces();
  if (captured.length > 0) return captured;
  const first = await gateway.nextTrace(Math.min(timeoutMs, 10_000));
  return [first, ...gateway.takeTraces()];
}

function fromProcess(
  phase: "cold" | "warm",
  provider: ProviderId,
  result: ProcessResult,
  telemetry: CacheTelemetry,
): TurnMeasurement {
  return {
    phase,
    provider,
    elapsedMs: result.elapsedMs,
    status: result.timedOut ? "timeout" : result.exitCode === 0 ? "completed" : "failed",
    telemetrySource: Object.keys(telemetry).length > 0 ? "agent" : "none",
    ...(result.firstByteMs === undefined ? {} : { firstByteMs: result.firstByteMs }),
    ...telemetry,
    ...(result.exitCode === 0 && !result.timedOut ? {} : { error: conciseProcessError(result) }),
  };
}

function roundResult(round: number, cold: TurnMeasurement, warm: TurnMeasurement): BenchmarkRound {
  return { round, cold, warm, ...classifyPair(cold, warm) };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findString(value: unknown, keys: readonly string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findString(item, keys);
      if (match) return match;
    }
    return undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const nested of Object.values(object)) {
    const match = findString(nested, keys);
    if (match) return match;
  }
  return undefined;
}

export function findAgentSessionId(value: unknown): string | undefined {
  return findString(value, ["session_id", "sessionId", "thread_id", "threadId", "taskId"]);
}

function parseJsonLines(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

interface EventWaiter {
  after: number;
  predicate(event: unknown): boolean;
  resolve(event: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class JsonlClient {
  readonly events: unknown[] = [];
  stderr = "";
  stdout = "";
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly stderrTask: Promise<void>;
  private readonly stdoutTask: Promise<void>;
  private readonly waiters = new Set<EventWaiter>();
  private stdoutBuffer = "";

  constructor(command: string[], cwd: string, env: Record<string, string | undefined>) {
    this.child = Bun.spawn({
      cmd: command,
      cwd,
      env: { ...process.env, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.stdoutTask = this.consumeStdout();
    this.stderrTask = this.consumeStderr();
    void this.child.exited.then(async (code) => {
      await Promise.allSettled([this.stdoutTask, this.stderrTask]);
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(`Agent RPC process exited with code ${code}: ${`${this.stderr}\n${this.stdout}`.trim()}`),
        );
      }
      this.waiters.clear();
    });
  }

  mark(): number {
    return this.events.length;
  }

  send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
    this.child.stdin.flush();
  }

  waitFor(predicate: (event: unknown) => boolean, after: number, timeoutMs: number): Promise<unknown> {
    for (let index = after; index < this.events.length; index += 1) {
      const event = this.events[index];
      if (event !== undefined && predicate(event)) return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        after,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting ${timeoutMs}ms for an agent RPC event`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Agent RPC process closed"));
    }
    this.waiters.clear();
    this.child.kill("SIGTERM");
    await Promise.race([this.child.exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }

  private publish(event: unknown): void {
    const index = this.events.push(event) - 1;
    for (const waiter of [...this.waiters]) {
      if (index < waiter.after || !waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  private async consumeStdout(): Promise<void> {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      this.stdout += text;
      this.stdoutBuffer += text;
      const lines = this.stdoutBuffer.split(/\r?\n/);
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.publish(JSON.parse(line));
        } catch {
          // Protocol stdout must remain JSONL; non-JSON diagnostics are ignored.
        }
      }
    }
  }

  private async consumeStderr(): Promise<void> {
    const reader = this.child.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.stderr += decoder.decode(value, { stream: true });
    }
  }
}

function isAutohandReady(event: unknown): boolean {
  return asObject(event)?.method === "autohand.agentStart";
}

function isAutohandTurnEnd(event: unknown): boolean {
  return asObject(event)?.method === "autohand.turnEnd";
}

export function isPiTurnEnd(event: unknown): boolean {
  return asObject(event)?.type === "agent_end";
}

async function executeRpcTurn(
  client: JsonlClient,
  gateway: Gateway,
  phase: "cold" | "warm",
  provider: ProviderId,
  prompt: string,
  protocol: "autohand" | "pi",
  timeoutMs: number,
): Promise<TurnMeasurement> {
  const after = client.mark();
  gateway.takeTraces();
  const started = performance.now();
  if (protocol === "autohand") {
    client.send({
      jsonrpc: "2.0",
      id: `${phase}-${crypto.randomUUID()}`,
      method: "autohand.prompt",
      params: { message: prompt },
    });
  } else {
    client.send({ type: "prompt", message: prompt });
  }
  await client.waitFor(protocol === "autohand" ? isAutohandTurnEnd : isPiTurnEnd, after, timeoutMs);
  const elapsedMs = performance.now() - started;
  return measurementFromGatewayTraces(
    phase,
    provider,
    elapsedMs,
    await completedTurnTraces(gateway, timeoutMs),
  );
}

async function runAutohand(
  options: AgentRoundOptions,
  root: string,
  workspace: string,
): Promise<BenchmarkRound> {
  const home = join(root, "autohand-home");
  await mkdir(home, { recursive: true });
  const authToken = await resolveAutohandAuthToken();
  const openRouterCredential = await resolveOpenRouterCredential();
  if (!authToken) throw new Error("Autohand RPC requires an existing authenticated Autohand session");
  if (!openRouterCredential) throw new Error("Autohand requires an OpenRouter API key");
  const gateway = await startGateway();
  const configPath = join(home, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        provider: "openrouter",
        auth: { token: authToken },
        openrouter: {
          apiKey: openRouterCredential.key,
          model: options.model,
          baseUrl: gateway.baseUrl,
        },
        workspace: { defaultRoot: workspace, allowDangerousOps: false },
        telemetry: { enabled: false },
        autoReport: { enabled: false },
        features: { promptCaching: true },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const client = new JsonlClient(
    [
      "bun",
      "run",
      "src/index.ts",
      "--mode",
      "rpc",
      "--config",
      configPath,
      "--path",
      workspace,
      "--bare",
      "--offline",
      "--restricted",
    ],
    AUTOHAND_REPO,
    { AUTOHAND_HOME: home, AUTOHAND_NO_BANNER: "1" },
  );
  try {
    await client.waitFor(isAutohandReady, 0, 60_000);
    const cold = await executeRpcTurn(
      client,
      gateway,
      "cold",
      options.provider,
      options.prompt.cold,
      "autohand",
      options.timeoutMs,
    );
    const warm = await executeRpcTurn(
      client,
      gateway,
      "warm",
      options.provider,
      options.prompt.followUp,
      "autohand",
      options.timeoutMs,
    );
    return roundResult(options.round, cold, warm);
  } finally {
    await client.close();
    await gateway.close();
  }
}

async function runPi(options: AgentRoundOptions, root: string, workspace: string): Promise<BenchmarkRound> {
  const configDirectory = join(root, "pi-agent");
  await mkdir(configDirectory, { recursive: true });
  const gateway = await startGateway();
  await writeFile(
    join(configDirectory, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          openrouter: {
            baseUrl: gateway.baseUrl,
            apiKey: "$OPENROUTER_API_KEY",
            api: "openai-completions",
            compat: {
              supportsUsageInStreaming: true,
              sendSessionAffinityHeaders: true,
              sessionAffinityFormat: "openrouter",
            },
            models: [
              {
                id: options.model,
                name: options.model,
                reasoning: false,
                input: ["text"],
                contextWindow: 131_072,
                maxTokens: 128,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(configDirectory, "settings.json"),
    `${JSON.stringify({ defaultProjectTrust: "never", enableInstallTelemetry: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const client = new JsonlClient(
    [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-tools",
      "--no-approve",
      "--provider",
      "openrouter",
      "--model",
      options.model,
      "--thinking",
      "off",
    ],
    workspace,
    {
      PI_CODING_AGENT_DIR: configDirectory,
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_SESSION_DIR: join(root, "pi-sessions"),
    },
  );
  try {
    const cold = await executeRpcTurn(
      client,
      gateway,
      "cold",
      options.provider,
      options.prompt.cold,
      "pi",
      options.timeoutMs,
    );
    const warm = await executeRpcTurn(
      client,
      gateway,
      "warm",
      options.provider,
      options.prompt.followUp,
      "pi",
      options.timeoutMs,
    );
    return roundResult(options.round, cold, warm);
  } finally {
    await client.close();
    await gateway.close();
  }
}

function codexConfig(gateway: Gateway, sessionId: string): string[] {
  return [
    "-c",
    'model_provider="openrouter"',
    "-c",
    'model_providers.openrouter.name="OpenRouter"',
    "-c",
    `model_providers.openrouter.base_url=${JSON.stringify(gateway.baseUrl)}`,
    "-c",
    'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    "-c",
    'model_providers.openrouter.wire_api="responses"',
    "-c",
    `model_providers.openrouter.http_headers={"X-OpenRouter-Cache"="false","x-session-id"=${JSON.stringify(sessionId)}}`,
  ];
}

async function runCodex(
  options: AgentRoundOptions,
  root: string,
  workspace: string,
): Promise<BenchmarkRound> {
  const gateway = await startGateway();
  const sessionAffinityId = `codex-${crypto.randomUUID()}`;
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  const config = codexConfig(gateway, sessionAffinityId);
  const common = [
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--model",
    options.model,
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'approval_policy="never"',
    ...config,
  ];
  const env = { CODEX_HOME: codexHome };
  try {
    gateway.takeTraces();
    const coldProcess = await runProcess({
      command: ["codex", "exec", ...common, options.prompt.cold],
      cwd: workspace,
      env,
      timeoutMs: options.timeoutMs,
    });
    let cold: TurnMeasurement;
    let threadId: string | undefined;
    if (coldProcess.exitCode === 0 && !coldProcess.timedOut) {
      cold = measurementFromGatewayTraces(
        "cold",
        options.provider,
        coldProcess.elapsedMs,
        await completedTurnTraces(gateway, options.timeoutMs),
      );
      threadId = findString(parseJsonLines(coldProcess.stdout), ["thread_id", "threadId"]);
    } else {
      cold = fromProcess("cold", options.provider, coldProcess, extractTelemetryFromText(coldProcess.stdout));
    }
    if (!threadId) {
      const warm: TurnMeasurement = {
        phase: "warm",
        provider: options.provider,
        elapsedMs: 0,
        status: "failed",
        telemetrySource: "none",
        error: "Codex did not emit a thread_id for the warm resume turn.",
      };
      return roundResult(options.round, cold, warm);
    }

    gateway.takeTraces();
    const warmProcess = await runProcess({
      command: ["codex", "exec", "resume", ...common, threadId, options.prompt.followUp],
      cwd: workspace,
      env,
      timeoutMs: options.timeoutMs,
    });
    const warm =
      warmProcess.exitCode === 0 && !warmProcess.timedOut
        ? measurementFromGatewayTraces(
            "warm",
            options.provider,
            warmProcess.elapsedMs,
            await completedTurnTraces(gateway, options.timeoutMs),
          )
        : fromProcess("warm", options.provider, warmProcess, extractTelemetryFromText(warmProcess.stdout));
    return roundResult(options.round, cold, warm);
  } finally {
    await gateway.close();
  }
}

interface ClineCommandOptions {
  dataDirectory: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  workspace: string;
}

export function buildClineCommand(options: ClineCommandOptions): string[] {
  return [
    "cline",
    "--json",
    "--auto-approve",
    "false",
    "--timeout",
    String(Math.ceil(options.timeoutMs / 1_000)),
    "--cwd",
    options.workspace,
    "--data-dir",
    options.dataDirectory,
    "--provider",
    "openrouter",
    "--model",
    options.model,
    "--thinking",
    "none",
    options.prompt,
  ];
}

function clineTelemetry(options: AgentRoundOptions, result: ProcessResult): CacheTelemetry {
  return {
    requestedModel: options.model,
    ...extractTelemetry(parseJsonLines(result.stdout)),
  };
}

async function runCline(
  options: AgentRoundOptions,
  root: string,
  workspace: string,
): Promise<BenchmarkRound> {
  const dataDirectory = join(root, "cline-data");
  const coldProcess = await runProcess({
    command: buildClineCommand({
      dataDirectory,
      model: options.model,
      prompt: options.prompt.cold,
      timeoutMs: options.timeoutMs,
      workspace,
    }),
    cwd: workspace,
    timeoutMs: options.timeoutMs,
  });
  const cold = fromProcess("cold", options.provider, coldProcess, clineTelemetry(options, coldProcess));
  const warmProcess = await runProcess({
    command: buildClineCommand({
      dataDirectory,
      model: options.model,
      prompt: options.prompt.warm,
      timeoutMs: options.timeoutMs,
      workspace,
    }),
    cwd: workspace,
    timeoutMs: options.timeoutMs,
  });
  const warm = fromProcess("warm", options.provider, warmProcess, clineTelemetry(options, warmProcess));
  return roundResult(options.round, cold, warm);
}

export async function runAgentRound(options: AgentRoundOptions): Promise<BenchmarkRound> {
  const credential = await resolveOpenRouterCredential();
  if (!credential) throw new Error("An OpenRouter API key is required for a live benchmark");
  const root = await mkdtemp(join(tmpdir(), `kv-cache-bench-${options.agent}-`));
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = credential.key;
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    "# KV cache benchmark workspace\n\nThis isolated workspace must remain unchanged.\n",
  );
  try {
    switch (options.agent) {
      case "autohand":
        return await runAutohand(options, root, workspace);
      case "pi":
        return await runPi(options, root, workspace);
      case "codex":
        return await runCodex(options, root, workspace);
      case "cline":
        return await runCline(options, root, workspace);
    }
    throw new Error(`Unsupported agent: ${String(options.agent)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
}
