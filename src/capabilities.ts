import { getProvider } from "./providers";
import type { AgentId, ProviderId } from "./types";

export class UnsupportedCombinationError extends Error {
  constructor(
    readonly agent: AgentId,
    readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedCombinationError";
  }
}

export interface Capability {
  agent: AgentId;
  provider: ProviderId;
  supported: boolean;
  reason?: string;
}

/**
 * Whether an agent can be benchmarked against a provider through the local gateway.
 *
 * Every agent in this benchmark speaks the OpenAI-compatible chat-completions wire to
 * the gateway. The gateway retargets that request to the provider's real endpoint and
 * injects the provider's credential, so any provider reachable over an OpenAI-compatible
 * endpoint works for every agent — that includes Google via its `/v1beta/openai/` layer.
 *
 * Anthropic exposes only its native Messages API; no agent emits that wire through the
 * benchmark gateway yet, so Anthropic combinations are reported unsupported (blocked)
 * rather than silently mis-measured. Wiring a native Anthropic route later flips this on.
 */
export function capabilityFor(agent: AgentId, provider: ProviderId): Capability {
  const config = getProvider(provider);
  // Cline's upstream base URL is not configurable in this harness, so it cannot be
  // retargeted through the gateway; only its native OpenRouter integration is benchmarked.
  if (agent === "cline" && provider !== "openrouter") {
    return {
      agent,
      provider,
      supported: false,
      reason:
        "Cline's upstream base URL is not gateway-configurable here; only its native OpenRouter integration is benchmarked.",
    };
  }
  const openAiCompatReachable =
    config.wireFormat === "openai-compat" || config.openAiCompatibleBaseUrl !== undefined;
  if (!openAiCompatReachable) {
    return {
      agent,
      provider,
      supported: false,
      reason: `${config.label} exposes only its native ${config.wireFormat} wire, which is not routed through the benchmark gateway yet.`,
    };
  }
  return { agent, provider, supported: true };
}

export function assertSupported(agent: AgentId, provider: ProviderId): void {
  const capability = capabilityFor(agent, provider);
  if (!capability.supported) {
    throw new UnsupportedCombinationError(agent, provider, capability.reason ?? "Unsupported combination.");
  }
}
