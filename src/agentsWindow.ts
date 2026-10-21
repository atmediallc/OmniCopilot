/** Legacy opt-in scoped model clones, not a stable Agents window API.
 * `targetChatSessionType` remains proposed; its private session identifier is
 * not a compatibility contract. Prefer unscoped entries: the inspected 1.141.2
 * native extension-BYOK bridge excludes scoped models. Kept disabled by default
 * for backward compatibility; do not infer live host support from helper tests.
 */

export const AGENT_HOST_SESSION_TYPE = "agent-host-copilotcli";

/** Suffix keeping the second entry's `id` unique next to the unscoped one. */
export const AGENTS_WINDOW_ID_SUFFIX = "::agents";

/** The local fork keys on `omnicopilot-dev`, mirroring the upstream setting. */
export const EXPOSE_TO_AGENTS_WINDOW_SETTING = "exposeToAgentsWindow";

export interface AgentsWindowCandidate {
  id: string;
  tooltip?: string;
  /** Mirrors `LanguageModelChatCapabilities`: a number is a max-tool-count and
   * still means tool calling is supported. */
  capabilities?: { toolCalling?: number | boolean; imageInput?: boolean };
}

function supportsTools(info: AgentsWindowCandidate): boolean {
  const tc = info.capabilities?.toolCalling;
  return tc === true || (typeof tc === "number" && tc > 0);
}

/**
 * Return the picker entries plus, when the feature is enabled, one
 * agent-host-scoped clone per tool-calling model. Models without tool calling
 * are not cloned — an agent session cannot use them, so the clone would be
 * dead weight in the Agents window picker.
 */
export function expandForAgentsWindow<T extends AgentsWindowCandidate>(
  infos: readonly T[],
  enabled: boolean
): Array<T & { targetChatSessionType?: string }> {
  if (!enabled) return [...infos];

  const agentEntries = infos
    .filter(supportsTools)
    .map((info) => ({
      ...info,
      id: `${info.id}${AGENTS_WINDOW_ID_SUFFIX}`,
      tooltip: info.tooltip ? `${info.tooltip} · Agents window` : "Agents window",
      targetChatSessionType: AGENT_HOST_SESSION_TYPE,
    }));

  return [...infos, ...agentEntries];
}
