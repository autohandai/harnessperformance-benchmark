import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_IDS, type ProviderId } from "./types";

export type WireFormat = "openai-compat" | "anthropic-native" | "gemini-native";

export interface ProviderCredential {
  key: string;
  source: "environment" | "autohand-config";
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  /** Upstream API base the local gateway proxies to for this provider's native wire format. */
  baseUrl: string;
  wireFormat: WireFormat;
  /** Environment variables checked in order for a credential. */
  credentialEnvVars: readonly string[];
  /** Section under ~/.autohand/config.json whose `apiKey` is a fallback credential, if any. */
  autohandConfigSection?: string;
  /** Auth headers the gateway injects when proxying to this provider. */
  authHeaders(key: string): Record<string, string>;
  /**
   * Base URL of this provider's OpenAI-compatible endpoint, when it offers one distinct
   * from `baseUrl`. Lets agents that only speak the OpenAI wire format reach the provider.
   */
  openAiCompatibleBaseUrl?: string;
}

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    wireFormat: "openai-compat",
    credentialEnvVars: ["OPENROUTER_API_KEY"],
    autohandConfigSection: "openrouter",
    authHeaders: bearer,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    wireFormat: "openai-compat",
    credentialEnvVars: ["OPENAI_API_KEY"],
    autohandConfigSection: "openai",
    authHeaders: bearer,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    wireFormat: "anthropic-native",
    credentialEnvVars: ["ANTHROPIC_API_KEY"],
    authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
  google: {
    id: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    wireFormat: "gemini-native",
    credentialEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    authHeaders: (key) => ({ "x-goog-api-key": key }),
    openAiCompatibleBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    wireFormat: "openai-compat",
    credentialEnvVars: ["NVIDIA_API_KEY"],
    autohandConfigSection: "nvidia",
    authHeaders: bearer,
  },
  zai: {
    id: "zai",
    label: "Zai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    wireFormat: "openai-compat",
    credentialEnvVars: ["ZAI_API_KEY"],
    autohandConfigSection: "zai",
    authHeaders: bearer,
  },
};

export function getProvider(id: ProviderId): ProviderConfig {
  return PROVIDERS[id];
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function configuredKey(value: unknown, environment: Record<string, string | undefined>): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = value.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/);
  if (match?.[1]) return environment[match[1]]?.trim() || undefined;
  return value.trim();
}

async function readAutohandSectionKey(
  configPath: string,
  section: string,
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const sectionValue = parsed[section];
    if (typeof sectionValue !== "object" || sectionValue === null) return undefined;
    return configuredKey((sectionValue as { apiKey?: unknown }).apiKey, environment);
  } catch {
    return undefined;
  }
}

export async function resolveProviderCredential(
  provider: ProviderId,
  environment: Record<string, string | undefined> = process.env,
  configPath = environment.AUTOHAND_CONFIG ?? join(homedir(), ".autohand", "config.json"),
): Promise<ProviderCredential | undefined> {
  const config = PROVIDERS[provider];
  for (const envVar of config.credentialEnvVars) {
    const value = environment[envVar]?.trim();
    if (value) return { key: value, source: "environment" };
  }
  if (config.autohandConfigSection) {
    const key = await readAutohandSectionKey(configPath, config.autohandConfigSection, environment);
    if (key) return { key, source: "autohand-config" };
  }
  return undefined;
}
