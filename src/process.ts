import type { ProcessResult } from "./types";

export interface ProcessOptions {
  command: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs: number;
}

async function consume(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
  const final = decoder.decode();
  if (final) onChunk(final);
}

export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  let firstByteMs: number | undefined;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const child = Bun.spawn({
    cmd: options.command,
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
    child.stdin.flush();
  }
  child.stdin.end();

  const markFirstByte = (): void => {
    firstByteMs ??= performance.now() - started;
  };
  const stdoutTask = consume(child.stdout, (chunk) => {
    markFirstByte();
    stdout += chunk;
  });
  const stderrTask = consume(child.stderr, (chunk) => {
    markFirstByte();
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
  }, options.timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  await Promise.all([stdoutTask, stderrTask]);

  return {
    command: [...options.command],
    exitCode,
    elapsedMs: performance.now() - started,
    stdout,
    stderr,
    timedOut,
    ...(firstByteMs === undefined ? {} : { firstByteMs }),
  };
}

export function conciseProcessError(result: ProcessResult): string {
  const text = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join(" ");
  if (result.timedOut) return `Timed out after ${Math.round(result.elapsedMs)}ms${text ? `: ${text}` : ""}`;
  return text || `Process exited with code ${result.exitCode}`;
}
