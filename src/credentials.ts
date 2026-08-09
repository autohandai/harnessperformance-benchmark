import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ProviderCredential, resolveProviderCredential } from "./providers";

export type OpenRouterCredential = ProviderCredential;

function configuredKey(value: unknown, environment: Record<string, string | undefined>): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = value.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/);
  if (match?.[1]) return environment[match[1]]?.trim() || undefined;
  return value.trim();
}

export function resolveOpenRouterCredential(
  environment: Record<string, string | undefined> = process.env,
  configPath = environment.AUTOHAND_CONFIG ?? join(homedir(), ".autohand", "config.json"),
): Promise<OpenRouterCredential | undefined> {
  return resolveProviderCredential("openrouter", environment, configPath);
}

export async function resolveAutohandAuthToken(
  environment: Record<string, string | undefined> = process.env,
  configPath = environment.AUTOHAND_CONFIG ?? join(homedir(), ".autohand", "config.json"),
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { auth?: { token?: unknown } };
    return configuredKey(parsed?.auth?.token, environment);
  } catch {
    return undefined;
  }
}
