import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenRouterCredential {
  key: string;
  source: "environment" | "autohand-config";
}

interface AutohandConfigSecrets {
  auth?: { token?: unknown };
  openrouter?: { apiKey?: unknown };
}

async function readAutohandConfig(configPath: string): Promise<AutohandConfigSecrets | undefined> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as AutohandConfigSecrets;
  } catch {
    return undefined;
  }
}

function configuredKey(value: unknown, environment: Record<string, string | undefined>): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = value.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/);
  if (match?.[1]) return environment[match[1]]?.trim() || undefined;
  return value.trim();
}

export async function resolveOpenRouterCredential(
  environment: Record<string, string | undefined> = process.env,
  configPath = environment.AUTOHAND_CONFIG ?? join(homedir(), ".autohand", "config.json"),
): Promise<OpenRouterCredential | undefined> {
  const environmentKey = environment.OPENROUTER_API_KEY?.trim();
  if (environmentKey) return { key: environmentKey, source: "environment" };

  const parsed = await readAutohandConfig(configPath);
  const key = configuredKey(parsed?.openrouter?.apiKey, environment);
  return key ? { key, source: "autohand-config" } : undefined;
}

export async function resolveAutohandAuthToken(
  environment: Record<string, string | undefined> = process.env,
  configPath = environment.AUTOHAND_CONFIG ?? join(homedir(), ".autohand", "config.json"),
): Promise<string | undefined> {
  const parsed = await readAutohandConfig(configPath);
  return configuredKey(parsed?.auth?.token, environment);
}
