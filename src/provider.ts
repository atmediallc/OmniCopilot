import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { OmniRouteClient, OmniRouteError, describeFetchError, formatErrorValue, isThrottleError, isTransientHttpError } from "./client";
import { isReasoningModel, resolveReasoningEffort } from "./reasoning";

import { AGENTS_WINDOW_ID_SUFFIX, EXPOSE_TO_AGENTS_WINDOW_SETTING, expandForAgentsWindow } from "./agentsWindow";
import { selectChatModels } from "./catalogFilter";
import { transportSurfaceLabel } from "./supportedEndpoints";
import {
  estimateTokens,
  requestRequiresVision,
  toOpenAiMessages,
  toOpenAiTools,
  trailingIdenticalToolCalls,
  MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS,
} from "./convert";
import { actionableFailureMessage } from "./chatErrors";
import {
  ContextBudgetError,
  enforceContextBudget,
  formatContextTokens,
  MODEL_CONTEXT_SETTINGS_KEY,
  modelContextSettingsKey,
  normalizeProviderMaxContext,
  readStoredContextSettings,
  resolveContextBudget,
  type ModelContextSettings,
} from "./contextBudget";
import {
  applyTransportPreference,
  buildCatalog,
  cachedLoadRoutes,
  clearRouteCooldown,
  getClientForRoute,
  markRouteCooldown,
  pickFallbackCandidates,
  transportPlanForModel,
} from "./routes";
import type { ChatRequest, ChatUsageInfo, OmniRouteModel, TransportPreference } from "./types";
import type { CatalogModel, FallbackCandidate, FallbackMode, FallbackRequirements, RouteCatalog } from "./routes";
import { finiteNonNegative, subsetTokens, type ResolvedChatUsage } from "./usage";

interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
  routeId: string;
  /** Derived from the catalog entry's capabilities (reasoning/thinking):
   * gates sending `reasoning_effort` on models that support it. */
  supportsReasoning?: boolean;
  /** #14 — proposed-API (`chatProvider`) field read by the host via duck
   * typing; scopes an entry to one chat session type (the Agents window's
   * agent host) and removes it from the general picker. See agentsWindow.ts. */
  targetChatSessionType?: string;
}

export interface ProviderDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  /** Called whenever a request round-trip settles, with success flag —
   * feeds the status bar without extra polling. */
  onActivity?: (ok: boolean, routeId?: string) => void;
  /** Live token usage while a chat response streams — feeds the status bar. */
  onUsage?: (usage: ResolvedChatUsage) => void;
  /** A chat request started streaming (status-bar live "responding" state). */
  onRequestStart?: (routeId: string | undefined, modelName: string) => void;
  /** A chat request settled. `error` is the surfaced failure message;
   * `fallbacksUsed` counts servers tried before the winning/exhausted one. */
  onRequestEnd?: (ok: boolean, error: string | undefined, fallbacksUsed: number) => void;
  /** routeIds that passed the most recent liveness probe; chat deprioritizes
   * the rest so unreachable servers aren't tried first. */
  getOnlineRouteIds?: () => ReadonlySet<string> | undefined;
  /** Called when a stream stalls (no SSE data within timeout). */
  onStall?: (routeId: string) => void;
}

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot-dev");
}

/** Builds a bounded, case-insensitive literal model filter. Treating the
 * workspace setting as data avoids executing user-controlled regular
 * expressions and their potential catastrophic backtracking. */
function compileModelFilter(filterRaw: string): ((modelId: string) => boolean) | undefined {
  const needle = filterRaw.slice(0, 200).toLocaleLowerCase();
  if (!needle) return undefined;
  return (modelId: string) => modelId.toLocaleLowerCase().includes(needle);
}

/** Small cancellation-aware pause between fallback attempts to avoid hammering
 * a busy server. Resolves immediately if already cancelled or when ms <= 0. */
function delay(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || token?.isCancellationRequested) {
      resolve();
      return;
    }
    let sub: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    if (token) {
      sub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        sub?.dispose();
        resolve();
      });
    }
  });
}


/** HTTP status code carried by an OmniRouteError, if any. */
function errorStatus(err: unknown): number | undefined {
  return err instanceof OmniRouteError ? err.status : undefined;
}

/** A definitive capacity rejection should fail over to another physical
 * route immediately; retrying the same route only amplifies saturation. */
function isExplicitAdmissionCapacityError(err: unknown): boolean {
  if (!(err instanceof OmniRouteError) || (err.status !== 429 && err.status !== 503)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("chat_admission_busy") ||
    message.includes("chat admission capacity is temporarily unavailable");
}

/** Structured `error.code` values OmniRoute reserves for request-GLOBAL
 * rejections (`VALID_*`, `COMBO_*`, `SECURITY_*` — see v3.8.50
 * src/shared/constants/errorCodes.ts). The same body would be rejected by
 * every route, so replaying it on other candidates cannot succeed. */
const GLOBAL_ERROR_CODE = /^(?:VALID|COMBO|SECURITY)_\d+$/;

/** Code-less 400s come from the chat route's early guards, which emit
 * `<field>: <reason>` details ("messages: Expected array", "Missing model",
 * "temperature: must be a number"…). Those are equally global. */
const GLOBAL_400_DETAIL = /\b(messages|model|temperature|top_p|max_tokens|n): |invalid json|missing model|image-generation model/;

/** True when a pre-stream 400/422 will be reproduced identically by every
 * other candidate. Route-local failures (MODEL_001/model_not_found,
 * PROVIDER_003 no-credentials, AUTH_*, or any other structured code) are
 * deliberately excluded — another route's credentials/catalog may serve. */
function isGlobalRequestRejection(err: unknown): boolean {
  if (!(err instanceof OmniRouteError) || (err.status !== 400 && err.status !== 422)) {
    return false;
  }
  if (err.code !== undefined) return GLOBAL_ERROR_CODE.test(err.code);
  return GLOBAL_400_DETAIL.test(err.message.toLowerCase());
}

/** Jittered delay between retries. Honors the upstream's Retry-After header
 * when present (capped at 30s) so a misbehaving server can't stall a request. */
function computeBackoffMs(err: unknown, isThrottle: boolean, attempted: number): number {
  const retryAfterMs = err instanceof OmniRouteError ? err.retryAfterMs : undefined;
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  const baseDelay = isThrottle ? 400 + crypto.randomInt(300) : 250;
  const maxDelay = isThrottle ? 1500 : 1000;
  return Math.min(maxDelay, baseDelay * (attempted + 1));
}

/** Invalid arguments must never become an executable call with defaults. */
function parseToolCallArgs(
  event: { args: string; name: string },
  log: vscode.LogOutputChannel
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Report the same protocol error for malformed and non-object JSON. */ }
  const message = `Invalid tool arguments for ${event.name}: expected a complete JSON object; tool was not executed.`;
  log.warn(message);
  throw new OmniRouteError(message, 400, false, "stream");
}

interface ConversationAffinity {
  routeId: string;
  modelId: string;
  baseUrl: string;
}

/** Everything needed to run a pinned chat request. */
interface ChatPlan {
  affinityKey?: string;
  interactive: boolean;
  clientByRoute: Map<string, OmniRouteClient>;
  nameByRoute: Map<string, string>;
  candidates: FallbackCandidate[];
  serverCount: number;
  modelId: string;
  retriesPerServer: number;
  /** Route IDs that THIS request put into cooldown during the fallback chain.
   * Used by the admission retry to only clear its own cooldowns, preserving
   * backpressure signals set by other concurrent requests. */
  cooledByThisRequest: Set<string>;
}

/** Context passed through the fallback chain for one chat request. */
interface ChatCandidateContext {
  cand: FallbackCandidate;
  client: OmniRouteClient;
  i: number;
  request: ChatRequest;
  inputTokens: number;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abort: AbortController;
  log: vscode.LogOutputChannel;
  routeName: string;
  retriesPerServer: number;
  /** Mutable set shared across all candidates in this request — tracks which
   * routes THIS request put into cooldown so the admission retry can clear
   * only its own cooldowns. */
  cooledByThisRequest: Set<string>;
}

/** Outcome of a single stream attempt. */
type StreamAttemptOutcome =
  | {
      kind: "completed";
      streamed: string;
      startedAt: number;
      firstTokenAt: number | undefined;
      reportedUsage?: ChatUsageInfo;
    }
  | { kind: "cancelled" }
  | {
      kind: "failed";
      error: unknown;
      /** True when the upstream rejected the request outright (pre-stream 4xx,
       * e.g. bad key/model/billing). Retrying this candidate is pointless —
       * the caller should move straight to the next one. */
      stall: boolean;
      throttle: boolean;
      permanent?: boolean;
    };

/** Outcome of a whole candidate (all of its retries). */
type CandidateOutcome =
  | { kind: "succeeded" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };

/** Final result of traversing the fallback candidates for one request. */
type ChatPlanOutcome =
  | { kind: "succeeded"; fallbacksUsed: number }
  | { kind: "cancelled"; fallbacksUsed: number }
  | {
      kind: "failed";
      routeId: string | undefined;
      fallbacksUsed: number;
      error: unknown;
      allAdmissionSaturated?: boolean;
    };

import { canonicalModelFamily, displayModelFamily, parseModelIdentity, type ModelIdentity } from "./modelIdentity";
export { canonicalModelFamily, displayModelFamily, parseModelIdentity, type ModelIdentity };

function conversationKey(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  if (!messages.length) return "default";
  const first = messages[0];
  const parts = Array.isArray(first.content) ? first.content : [];
  for (const p of parts) {
    if (p instanceof vscode.LanguageModelTextPart && p.value.trim().length > 0) {
      return p.value.slice(0, 80);
    }
  }
  return "default";
}

export class OmniRouteChatProvider
  implements vscode.LanguageModelChatProvider<OmniModelInfo>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private readonly lastLoopModelByConversation = new Map<string, string>();

  private static readonly sharedRouteCatalogs = new Map<string, RouteCatalog>();
  private static readonly sharedRouteFetchPromises = new Map<string, Promise<RouteCatalog>>();
  private static sharedCachedModels: CatalogModel[] = [];
  private static sharedLastCatalogFetch = 0;
  private static sharedRefreshGeneration = 0;
  private static readonly CACHE_STATE_KEY = "omnicopilot-dev.cachedCatalog.v1";
  private static readonly CACHE_TIME_KEY = "omnicopilot-dev.cachedCatalogTime.v1";

  private static rebuildSharedCatalog(): CatalogModel[] {
    const segments = Array.from(OmniRouteChatProvider.sharedRouteCatalogs.values());
    const catalog = buildCatalog(segments);
    OmniRouteChatProvider.sharedCachedModels = catalog;
    return catalog;
  }

  static loadPersistentCache(context: vscode.ExtensionContext): void {
    const savedCatalog = context.globalState.get<CatalogModel[]>(OmniRouteChatProvider.CACHE_STATE_KEY);
    const savedTime = context.globalState.get<number>(OmniRouteChatProvider.CACHE_TIME_KEY);
    if (Array.isArray(savedCatalog) && savedCatalog.length > 0 && typeof savedTime === "number" && savedTime > 0) {
      OmniRouteChatProvider.sharedCachedModels = savedCatalog;
      OmniRouteChatProvider.sharedLastCatalogFetch = savedTime;

      // Reconstruct sharedRouteCatalogs from disk so per-route fallback / retention
      // works even if a route is slow or fails on its very first discovery run
      // after VS Code restarts or reloads.
      const byRoute = new Map<string, { routeId: string; name: string; models: OmniRouteModel[] }>();
      for (const item of savedCatalog) {
        if (!item?.entry?.routeId || !item?.model) continue;
        let seg = byRoute.get(item.entry.routeId);
        if (!seg) {
          seg = {
            routeId: item.entry.routeId,
            name: item.entry.routeName || item.entry.routeId,
            models: [],
          };
          byRoute.set(item.entry.routeId, seg);
        }
        seg.models.push(item.model);
      }
      for (const [routeId, seg] of byRoute) {
        OmniRouteChatProvider.sharedRouteCatalogs.set(routeId, seg);
      }
    }
  }

  private static async persistCache(context: vscode.ExtensionContext, catalog: CatalogModel[]): Promise<void> {
    // Persist a slim slice of each entry: full catalogs can hold thousands
    // of models and globalState is file-backed JSON (slow, storage-heavy).
    const slim: CatalogModel[] = catalog.map((c) => ({
      entry: {
        routeId: c.entry.routeId,
        routeName: c.entry.routeName,
        modelId: c.entry.modelId,
        prefixedId: c.entry.prefixedId,
      },
      model: {
        id: c.model.id,
        owned_by: c.model.owned_by,
        display_name: c.model.display_name,
        name: c.model.name,
        context_length: c.model.context_length,
        max_output_tokens: c.model.max_output_tokens,
        max_completion_tokens: c.model.max_completion_tokens,
        supported_endpoints: c.model.supported_endpoints,
        capabilities: {
          tool_calling: c.model.capabilities?.tool_calling,
          vision: c.model.capabilities?.vision,
          reasoning: c.model.capabilities?.reasoning,
          thinking: c.model.capabilities?.thinking,
        },
      },
    }));
    await context.globalState.update(OmniRouteChatProvider.CACHE_STATE_KEY, slim);
    await context.globalState.update(OmniRouteChatProvider.CACHE_TIME_KEY, Date.now());
  }

  /** Drops catalog segments whose routes are no longer configured, so model
   * discovery never serves stale entries. */
  private static pruneStaleRouteCatalogs(validRouteIds: Set<string>): boolean {
    let pruned = false;
    for (const key of Array.from(OmniRouteChatProvider.sharedRouteCatalogs.keys())) {
      if (!validRouteIds.has(key)) {
        OmniRouteChatProvider.sharedRouteCatalogs.delete(key);
        pruned = true;
      }
    }
    return pruned;
  }

  /** Evicts a specific model from a route's cached catalog (e.g. after a runtime 404). */
  static pruneModel(routeId: string, modelId: string): boolean {
    const seg = OmniRouteChatProvider.sharedRouteCatalogs.get(routeId);
    if (!seg) return false;
    const idx = seg.models.findIndex((m) => m.id === modelId);
    if (idx !== -1) {
      seg.models.splice(idx, 1);
      OmniRouteChatProvider.rebuildSharedCatalog();
      return true;
    }
    return false;
  }

  constructor(
    private readonly deps: ProviderDeps,
    public readonly filterRouteId?: string
  ) {}

  get cachedModels(): CatalogModel[] {
    return OmniRouteChatProvider.sharedCachedModels;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** Re-query the catalog and tell VS Code the model list changed. */
  async refresh(): Promise<void> {
    OmniRouteChatProvider.sharedRefreshGeneration++;
    OmniRouteChatProvider.sharedRouteFetchPromises.clear();
    OmniRouteChatProvider.sharedLastCatalogFetch = 0;
    this._onDidChange.fire();
  }


  // ── Model discovery ─────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    optionsOrToken?: { silent?: boolean } | vscode.CancellationToken,
    maybeToken?: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const isToken = Boolean(optionsOrToken && typeof optionsOrToken === "object" && "isCancellationRequested" in optionsOrToken);
    const token = isToken ? (optionsOrToken as vscode.CancellationToken) : maybeToken;
    const silent = isToken ? true : Boolean((optionsOrToken as { silent?: boolean })?.silent);

    const routes = await cachedLoadRoutes(this.deps.context);
    if (routes.length === 0) {
      OmniRouteChatProvider.sharedRouteCatalogs.clear();
      OmniRouteChatProvider.sharedCachedModels = [];
      OmniRouteChatProvider.sharedLastCatalogFetch = Date.now();
      void OmniRouteChatProvider.persistCache(this.deps.context, []);
      return [];
    }

    const validRouteIds = new Set(routes.map((r) => r.id));

    // Prune entries from sharedRouteCatalogs that belong to routes no longer configured
    if (OmniRouteChatProvider.pruneStaleRouteCatalogs(validRouteIds)) {
      OmniRouteChatProvider.sharedCachedModels = OmniRouteChatProvider.rebuildSharedCatalog();
      void OmniRouteChatProvider.persistCache(this.deps.context, OmniRouteChatProvider.sharedCachedModels);
    }

    const activeRoutes = routes.slice(0, 10);
    const allRoutesCached = activeRoutes.every((r) =>
      OmniRouteChatProvider.sharedRouteCatalogs.has(r.id)
    );

    const ttlMinutes = getConfig().get<number>("modelCacheTtlMinutes", 60);
    const isManualOnly = ttlMinutes <= 0;
    const ttlMs = isManualOnly ? Number.POSITIVE_INFINITY : ttlMinutes * 60_000;
    const isFresh = allRoutesCached && (Date.now() - OmniRouteChatProvider.sharedLastCatalogFetch < ttlMs);

    if (OmniRouteChatProvider.sharedCachedModels.length > 0 && isFresh) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels, validRouteIds);
    }

    const refreshGeneration = OmniRouteChatProvider.sharedRefreshGeneration;

    const segments: RouteCatalog[] = await Promise.all(
      activeRoutes.map(async (r) => {
        let fetchP = OmniRouteChatProvider.sharedRouteFetchPromises.get(r.id);
        if (!fetchP) {
          fetchP = (async () => {
            try {
              const models = await getClientForRoute(r, this.deps.log).listModels(token);
              // Count what actually reaches the picker after catalog shaping
              // (specialty registries + dual-prefix mirrors are dropped), so a
              // silent all-drop (e.g. wrong `type` from a server version skew)
              // shows as "0/N" instead of a misleading "succeeded: N".
              const chatModels = selectChatModels(models);
              this.deps.onActivity?.(true, r.id);
              this.deps.log.info(
                `Route "${r.name}" (${r.baseUrl}) model discovery succeeded: ${chatModels.length}/${models.length} chat model(s)`
              );
              if (models.length > 0 && chatModels.length === 0) {
                const sample = models
                  .slice(0, 3)
                  .map(
                    (m) =>
                      `${m.id} (type=${m.type ?? "-"}, endpoints=${JSON.stringify(m.supported_endpoints ?? [])}, parent=${m.parent ?? "-"})`
                  )
                  .join(", ");
                this.deps.log.warn(
                  `Route "${r.name}" filtered out ALL ${models.length} model(s) — server catalog shape is incompatible. Sample: ${sample}`
                );
              }
              return { routeId: r.id, name: r.name, models };
            } catch (err) {
              this.deps.onActivity?.(false, r.id);
              this.deps.log.warn(
                `Route "${r.name}" (${r.baseUrl}) model discovery failed: ${formatErrorValue(err)}`
              );
              // A failed discovery must never wipe the picker: the route may be
              // alive but slow (headers past the budget, transient timeout),
              // and dropping its models makes the selected model vanish
              // mid-chat (VS Code then fails with NotFound, killing the chat).
              // Keep the last-known-good catalog until discovery succeeds again.
              const lastKnown = OmniRouteChatProvider.sharedRouteCatalogs.get(r.id);
              if (lastKnown && lastKnown.models.length > 0) {
                this.deps.log.warn(
                  `Route "${r.name}" discovery failed — keeping ${lastKnown.models.length} previously discovered model(s) from the last successful refresh`
                );
                return lastKnown;
              }
              // Secondary safety: if sharedRouteCatalogs was empty, check sharedCachedModels
              const fallbackModels = OmniRouteChatProvider.sharedCachedModels
                .filter((c) => c.entry.routeId === r.id)
                .map((c) => c.model);
              if (fallbackModels.length > 0) {
                this.deps.log.warn(
                  `Route "${r.name}" discovery failed — keeping ${fallbackModels.length} cached model(s)`
                );
                return { routeId: r.id, name: r.name, models: fallbackModels };
              }
              return { routeId: r.id, name: r.name, models: [] };
            }
          })().finally(() => {
            if (OmniRouteChatProvider.sharedRouteFetchPromises.get(r.id) === fetchP) {
              OmniRouteChatProvider.sharedRouteFetchPromises.delete(r.id);
            }
          });
          OmniRouteChatProvider.sharedRouteFetchPromises.set(r.id, fetchP);
        }
        return fetchP;
      })
    );

    if (refreshGeneration !== OmniRouteChatProvider.sharedRefreshGeneration) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels, validRouteIds);
    }
    for (const seg of segments) {
      OmniRouteChatProvider.sharedRouteCatalogs.set(seg.routeId, seg);
    }
    const catalog = OmniRouteChatProvider.rebuildSharedCatalog();
    OmniRouteChatProvider.sharedLastCatalogFetch = Date.now();
    void OmniRouteChatProvider.persistCache(this.deps.context, catalog);

    const infos = this.toModelInfos(catalog, validRouteIds);
    if (infos.length === 0) {
      // No route answered with a model list matching this provider. Only prompt when the caller
      // wants it (model picker opened by the user); otherwise contribute none.
      if (!silent && !this.filterRouteId) void this.offerConnectionHelp();
      return [];
    }

    this.deps.log.info(
      `Listed ${infos.length} models for vendor (filterRouteId: ${this.filterRouteId ?? "all"}, total cached: ${catalog.length})`
    );
    return infos;
  }

  private toModelInfos(catalog: CatalogModel[], validRouteIds?: Set<string>): OmniModelInfo[] {
    const cfg = getConfig();
    const maxOutput = cfg.get<number>("maxOutputTokens", 8192);
    const defaultContext = cfg.get<number>("defaultContextLength", 128000);
    const filter = compileModelFilter(cfg.get<string>("modelFilter", "").trim());

    const infos: OmniModelInfo[] = [];
    for (const c of catalog) {
      if (!this.isModelEligible(c, filter, validRouteIds)) continue;
      infos.push(this.toModelInfo(c, maxOutput, defaultContext));
    }
    // #14: opt-in second set of entries scoped to the Copilot Agents window.
    // Same omniModelId → the chat path needs no change for these clones.
    return expandForAgentsWindow(
      infos,
      cfg.get<boolean>(EXPOSE_TO_AGENTS_WINDOW_SETTING, false)
    );
  }

  /** Route/filter gating for one catalog entry: must belong to a valid route
   * (when given), match this provider's route (when scoped), carry an id, and
   * pass the user's model filter. */
  private isModelEligible(
    c: CatalogModel,
    filter: ((modelId: string) => boolean) | undefined,
    validRouteIds?: Set<string>
  ): boolean {
    if (validRouteIds && !validRouteIds.has(c.entry.routeId)) return false;
    if (this.filterRouteId && c.entry.routeId !== this.filterRouteId) return false;
    const model = c.model;
    if (!model?.id) return false;
    if (filter && !filter(model.id)) return false;
    return true;
  }

  /** Builds the VS Code model descriptor for one catalog entry. */
  private toModelInfo(
    c: CatalogModel,
    maxOutput: number,
    defaultContext: number
  ): OmniModelInfo {
    const model = c.model;
    const contextLength = normalizeProviderMaxContext(model.context_length, defaultContext).tokens;
    const catalogMaxOutput = model.max_output_tokens ?? model.max_completion_tokens;
    const maxOutputTokens = Math.min(catalogMaxOutput ?? maxOutput, maxOutput);
    const caps = model.capabilities ?? {};
    const isCombo = model.owned_by === "combo";
    const supportsReasoning = isReasoningModel(model);
    // The picker shows the model's catalog id as-is plus the server name in
    // parentheses — `oc/big-pickle (HomeNAS)` — so every entry is instantly
    // attributable to its server and reads like OmniRoute's own import list.
    // The internal `id` stays unique (route suffix on collision) and is what
    // the provider resolves back to a catalog entry.
    const routeHint = c.entry.routeName || "OmniCopilot";
    const name = `${model.id} (${routeHint})`;

    const ctxTag = `${formatContextTokens(contextLength)} ctx`;
    const capsTags: string[] = [ctxTag];
    if (supportsReasoning) capsTags.push("extended thinking");
    if (caps.vision === true) capsTags.push("vision");

    // Per-model API-surface indication, derived from the same authoritative
    // transport plan used for streaming.
    const surfaceTags = transportSurfaceLabel(transportPlanForModel(model));
    capsTags.push(surfaceTags);

    const routeLabel = c.entry.routeName || "OmniCopilot";
    const tooltip = `${routeLabel} · ${model.id} (${capsTags.join(" · ")})`;
    const identity = parseModelIdentity(model.id, model.owned_by);

    return {
      id: c.entry.prefixedId,
      name,
      family: identity.displayFamily,
      version: "1.0.0",
      detail: isCombo ? `combo · ${surfaceTags}` : (c.entry.routeName || model.owned_by),
      tooltip,
      maxInputTokens: Math.max(contextLength - maxOutputTokens, 1024),
      maxOutputTokens,
      capabilities: {
        // Unknown capability defaults to NO tool calling: advertising tools
        // to a model without support yields a 400 + a wasted fallback chain.
        toolCalling: caps.tool_calling === true ||
          (typeof caps.tool_calling === "number" && Number.isSafeInteger(caps.tool_calling) && caps.tool_calling > 0)
          ? caps.tool_calling : false,
        imageInput: caps.vision === true,
      },
      omniModelId: model.id,
      routeId: c.entry.routeId,
      supportsReasoning,
    };
  }

  private async offerConnectionHelp(): Promise<void> {
    const routes = await cachedLoadRoutes(this.deps.context);
    const baseUrl = routes[0]?.baseUrl ?? "http://localhost:20128/v1";

    const configureLabel = vscode.l10n.t("Configure Connection");
    const installLabel = vscode.l10n.t("Install OmniRoute");
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t("Could not reach OmniRoute at {0}. Is it running?", baseUrl),
      configureLabel,
      installLabel
    );
    if (pick === configureLabel) {
      void vscode.commands.executeCommand("omnicopilot-dev.manage");
    } else if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot-dev.installOmniRoute");
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────

  private static readonly conversationRequests = new WeakMap<vscode.Memento, Map<string, Promise<void>>>();

  async provideLanguageModelChatResponse(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const sessionId = options.modelOptions?.conversationId;
    if (typeof sessionId !== "string" || !sessionId) {
      return this.respondToConversation(model, messages, options, progress, token);
    }
    let requests = OmniRouteChatProvider.conversationRequests.get(this.deps.context.globalState);
    if (!requests) {
      requests = new Map();
      OmniRouteChatProvider.conversationRequests.set(this.deps.context.globalState, requests);
    }
    const previous = requests.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.respondToConversation(model, messages, options, progress, token));
    requests.set(sessionId, current);
    try {
      await current;
    } finally {
      if (requests.get(sessionId) === current) requests.delete(sessionId);
    }
  }

  private async respondToConversation(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }
    const log = this.deps.log;
    const maxConsecutive = getConfig().get<number>(
      "maxConsecutiveIdenticalToolCalls",
      MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS
    );
    const loop = maxConsecutive > 0 ? trailingIdenticalToolCalls(messages, true) : undefined;
    const convKey = conversationKey(messages);
    const lastLoopModelId = this.lastLoopModelByConversation.get(convKey);
    if (loop && loop.count >= maxConsecutive) {
      if (lastLoopModelId === model.omniModelId) {
        // The user or host was already alerted on this model and explicitly retried:
        // Allow the attempt to proceed so the conversation is not permanently bricked.
        log.warn(
          `Loop guard bypassed on user retry for ${model.omniModelId} (${loop.count}x "${loop.name}")`
        );
        this.lastLoopModelByConversation.delete(convKey);
      } else if (lastLoopModelId && lastLoopModelId !== model.omniModelId) {
        log.info(
          `Loop guard reset: user switched model from ${lastLoopModelId} to ${model.omniModelId}`
        );
        this.lastLoopModelByConversation.delete(convKey);
      } else {
        if (this.lastLoopModelByConversation.size > 50) this.lastLoopModelByConversation.clear();
        this.lastLoopModelByConversation.set(convKey, model.omniModelId);
        const message =
          `Stopped before sending: the conversation holds ${loop.count} completed identical calls with unchanged results ` +
          `to tool "${loop.name}" — no progress is visible. Rephrase the request, switch to a ` +
          `more capable model, or start a fresh chat rather than spending more tokens on identical iterations.`;
        log.warn(`Loop guard refused chat with ${model.omniModelId}: ${loop.count}x "${loop.name}"`);
        this.deps.onRequestEnd?.(false, message, 0);
        throw new OmniRouteError(message, undefined);
      }
    } else {
      this.lastLoopModelByConversation.delete(convKey);
    }
    const request = this.buildChatRequest(model, messages, options);
    const plan = await this.resolveChatPlan(model, request, options, log);

    const abort = new AbortController();
    if (token.isCancellationRequested) {
      abort.abort();
    }
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    try {
      await this.executeChatPlan(plan, request, progress, token, abort);
    } finally {
      cancelSub.dispose();
    }
  }

  /** Builds the wire request for the selected model: OpenAI-compatible chat
   * payload with the user's tool cap, mandatory tool mode and temperature. */
  private buildChatRequest(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions
  ): ChatRequest {
    const request: ChatRequest = {
      model: model.omniModelId,
      messages: toOpenAiMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      tools: this.capTools(options.tools, model.capabilities?.toolCalling),
      max_tokens: model.maxOutputTokens,
    };
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      request.tool_choice = "required";
    }
    const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
    if (typeof modelOptions?.temperature === "number") {
      request.temperature = modelOptions.temperature;
    }
    const effort = resolveReasoningEffort({
      modelOptions,
      configuredDefault: getConfig().get<string>("defaultReasoningEffort", ""),
      modelIsReasoning: Boolean(model.supportsReasoning),
    });
    if (effort) {
      request.reasoning_effort = effort;
    }
    return request;
  }

  /** Forward every authorized tool, or fail visibly on a known capacity.
   * Never discard tools by their position in the manifest. */
  private capTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
    toolCalling: boolean | number | undefined
  ): ReturnType<typeof toOpenAiTools> {
    const allTools = toOpenAiTools(tools);
    if (!allTools?.length) return allTools;
    const maxTools = getConfig().get<number>("maxTools", 0);
    const limits = [maxTools, typeof toolCalling === "number" ? toolCalling : 0]
      .filter((limit) => Number.isSafeInteger(limit) && limit > 0);
    if (toolCalling === false) throw new Error("Selected model does not support tool calling.");
    if (limits.some((limit) => allTools.length > limit)) {
      throw new Error(`Tool definition limit exceeded: host offered ${allTools.length}; limit ${Math.min(...limits)}. Select fewer tools or a model with sufficient capacity; no tools were discarded.`);
    }
    return allTools;
  }

  /** Resolves the fallback chain for the selected model: primary → same model
   * on another route → same family on the same route → any compatible model.
   * A route disappearing mid-session is skipped, never fatal. Offline servers
   * are deprioritized so a dead secondary never delays a healthy primary. */
  private async resolveChatPlan(
    model: OmniModelInfo,
    request: ChatRequest,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    log: vscode.LogOutputChannel
  ): Promise<ChatPlan> {
    const cfg = getConfig();
    const routes = await cachedLoadRoutes(this.deps.context);
    const firstByteTimeoutMs =
      cfg.get<number>("firstByteTimeoutSeconds", 120) * 1000;
    const streamIdleTimeoutMs =
      cfg.get<number>("idleTimeoutSeconds", 120) * 1000;
    const compressionOverride = cfg.get<string>("compressionOverride", "serverDefault");
    const clientByRoute = new Map(
      routes.map((r) => [r.id, getClientForRoute(r, this.deps.log, firstByteTimeoutMs, compressionOverride, streamIdleTimeoutMs)])
    );
    const nameByRoute = new Map(routes.map((r) => [r.id, r.name]));

    const targetPrefixedId = model.id.endsWith(AGENTS_WINDOW_ID_SUFFIX)
      ? model.id.slice(0, -AGENTS_WINDOW_ID_SUFFIX.length)
      : model.id;
    // Stable caller-supplied IDs are required to share authorization across turns.
    // History hashes cannot distinguish two sessions with the same initial prompt.
    const sessionId = options.modelOptions?.conversationId;
    const affinityKey = typeof sessionId === "string" && sessionId.length > 0
      ? `omnicopilot-dev.affinity.v1.${crypto.createHash("sha256").update(sessionId).digest("hex")}`
      : undefined;
    const pinned = affinityKey
      ? this.deps.context.globalState.get<ConversationAffinity>(affinityKey)
      : undefined;
    if (pinned && pinned.modelId !== model.omniModelId) {
      throw new Error("Conversation model identity is pinned. Start a new conversation to select another model.");
    }
    const primaryCatalogModel = this.cachedModels.find((c) => pinned
      ? c.entry.routeId === pinned.routeId && c.entry.modelId === pinned.modelId
      : model.routeId && model.omniModelId
        ? c.entry.routeId === model.routeId && c.entry.modelId === model.omniModelId
        : c.entry.prefixedId === targetPrefixedId);
    if (pinned && (!primaryCatalogModel || clientByRoute.get(pinned.routeId)?.baseUrl !== pinned.baseUrl)) {
      throw new Error("Pinned conversation server/model is unavailable or its URL changed; no server was substituted.");
    }
    const primaryEntry = primaryCatalogModel?.entry;
    if (!primaryEntry) {
      this.deps.log.warn(
        `Primary model not found in catalog: ${model.id} (${this.cachedModels.length} cached)`
      );
    }
    // User-selected transport override: `auto` keeps the catalog-derived plan;
    // a concrete value narrows every candidate to that single protocol.
    const preference = getConfig().get<TransportPreference>("transport", "auto");
    const defaultContext = cfg.get<number>("defaultContextLength", 128_000);
    const fallbackRequirements: FallbackRequirements = {
      needsTools: Boolean(options.tools?.length),
      toolCount: request.tools?.length ?? 0,
      needsVision: requestRequiresVision(request),
      minContextTokens: estimateTokens(request.messages),
      fallbackContextTokens: defaultContext,
      transportPreference: preference,
    };
    const fallbackCatalog = this.cachedModels;
    const fallbacks = (primaryEntry
      ? pickFallbackCandidates(
          primaryEntry,
          fallbackCatalog,
          fallbackRequirements,
          getConfig().get<FallbackMode>("fallbackMode", "askBeforeSwitch")
        )
      : []
    ).map((candidate) => ({
      ...candidate,
      transportPlan: applyTransportPreference(candidate.transportPlan, preference),
    }));
    if (!primaryEntry && (!model.routeId || !model.omniModelId)) {
      const msg = `Model ${model.id} is not available or not properly configured`;
      const LMError = (vscode as unknown as Record<string, unknown>).LanguageModelError as
        | { NotFound?: (m?: string) => Error }
        | undefined;
      throw LMError?.NotFound?.(msg) ?? new OmniRouteError(msg, undefined);
    }
    const primary: FallbackCandidate = primaryEntry
      ? {
          routeId: primaryEntry.routeId,
          modelId: primaryEntry.modelId,
          transportPlan: applyTransportPreference(
            transportPlanForModel(primaryCatalogModel?.model),
            preference
          ),
        }
      : {
          routeId: model.routeId!,
          modelId: model.omniModelId!,
          transportPlan: applyTransportPreference(["responses", "chatCompletions"], preference),
        };

    log.info(
      `Selected model: ${primary.modelId} on route ${primary.routeId} (prefixedId: ${model.id}, catalog: ${this.cachedModels.length} models)`
    );

    const candidates = [primary, ...fallbacks];
    const client = clientByRoute.get(primary.routeId);
    if (!client) throw new Error("Selected conversation server is unavailable; no server was substituted.");
    if (affinityKey && !pinned) {
      await this.deps.context.globalState.update(affinityKey, {
        routeId: primary.routeId, modelId: primary.modelId, baseUrl: client.baseUrl,
      } satisfies ConversationAffinity);
    }
    const serverCount = 1;

    // Pre-compute the fallback chain readout: building it inline would nest a
    // template literal inside another one (Sonar S4624).
    const fallbackSummary = candidates.slice(1).map((f) => `${f.routeId}:${f.modelId}`).join(", ");
    log.info(
      `Chat → ${primary.modelId} @${primary.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbackSummary}` : "")
    );

    const retriesPerServer = getConfig().get<number>("retriesPerServer", 1);
    return {
      affinityKey,
      interactive: Boolean(affinityKey && options.modelOptions?.interactive === true && vscode.window.state.focused),
      clientByRoute,
      nameByRoute,
      candidates,
      serverCount,
      modelId: model.omniModelId,
      retriesPerServer,
      cooledByThisRequest: new Set<string>(),
    };
  }

  /** Walks the fallback chain, one candidate at a time, until one succeeds or
   * every candidate is exhausted. Returns on success/cancellation; throws the
   * final error when the chain is exhausted. */
  private async executeChatPlan(
    plan: ChatPlan,
    request: ChatRequest,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abort: AbortController
  ): Promise<void> {
    this.deps.onRequestStart?.(plan.candidates[0]?.routeId, plan.modelId);
    let requestSettled = false;

    try {
      const outcome = await this.runChatCandidates(plan, request, progress, token, abort);

      requestSettled = true;
      if (outcome.kind === "succeeded") {
        this.deps.onRequestEnd?.(true, undefined, outcome.fallbacksUsed);
        return;
      }
      if (outcome.kind === "cancelled") {
        this.deps.onRequestEnd?.(false, undefined, outcome.fallbacksUsed);
        return;
      }
      this.reportChatFailure({
        routeId: outcome.routeId,
        routeName: outcome.routeId ? plan.nameByRoute.get(outcome.routeId) : undefined,
        fallbacksUsed: outcome.fallbacksUsed,
        err: outcome.error,
        modelId: plan.modelId,
        serverCount: plan.serverCount,
        candidateCount: plan.candidates.length,
      });
    } catch (err) {
      if (!requestSettled) {
        requestSettled = true;
        this.deps.onRequestEnd?.(false, describeFetchError(err), 0);
      }
      throw err;
    }
  }

  /** Traverses fallback candidates without owning request lifecycle callbacks. */
  private async runChatCandidates(
    plan: ChatPlan,
    request: ChatRequest,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abort: AbortController
  ): Promise<ChatPlanOutcome> {
    let cand = plan.candidates[0];
    let switches = 0;
    const visited = new Set<string>();
    while (cand) {
      if (token.isCancellationRequested) return { kind: "cancelled", fallbacksUsed: switches };
      visited.add(cand.routeId);
      const client = plan.clientByRoute.get(cand.routeId);
      if (!client) throw new Error(`Pinned route ${cand.routeId} is not configured`);
      const prepared = await this.prepareCandidateRequest(cand, request);
      const outcome = await this.tryCandidate({
        cand, client, i: switches, request: prepared.request, inputTokens: prepared.inputTokens,
        progress, token, abort, log: this.deps.log,
        routeName: plan.nameByRoute.get(cand.routeId) ?? cand.routeId,
        retriesPerServer: plan.retriesPerServer,
        cooledByThisRequest: plan.cooledByThisRequest,
      });
      if (outcome.kind !== "failed") return { kind: outcome.kind, fallbacksUsed: switches };
      const failed: ChatPlanOutcome = { kind: "failed", routeId: cand.routeId, fallbacksUsed: switches, error: outcome.error };
      if (!plan.interactive || token.isCancellationRequested || isGlobalRequestRejection(outcome.error)) return failed;
      const next = plan.candidates.find((c) => !visited.has(c.routeId));
      const switchLabel = next ? `Authorize switch to ${plan.nameByRoute.get(next.routeId) ?? next.routeId}` : undefined;
      const retryLabel = "Retry Current Server";
      const choices = switchLabel ? [retryLabel, switchLabel, "Cancel"] : [retryLabel, "Cancel"];
      const cancelled = new Promise<undefined>((resolve) => {
        const sub = token.onCancellationRequested(() => { sub.dispose(); resolve(undefined); });
        abort.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      const pick = await Promise.race([
        vscode.window.showWarningMessage(
          `Server ${plan.nameByRoute.get(cand.routeId) ?? cand.routeId} failed for exact model ${cand.modelId}. No server or model has been changed.`,
          { modal: true, detail: "Switching sends this conversation to the selected server. Approval applies only to this conversation." },
          ...choices
        ), cancelled,
      ]);
      if (token.isCancellationRequested || abort.signal.aborted) return { kind: "cancelled", fallbacksUsed: switches };
      if (pick === retryLabel) continue;
      if (!next || pick !== switchLabel) return failed;
      const nextClient = plan.clientByRoute.get(next.routeId);
      if (!nextClient || !plan.affinityKey) return failed;
      await this.deps.context.globalState.update(plan.affinityKey, {
        routeId: next.routeId, modelId: next.modelId, baseUrl: nextClient.baseUrl,
      } satisfies ConversationAffinity);
      this.deps.log.info(`User authorized conversation switch ${cand.routeId} → ${next.routeId}; exact model ${next.modelId}`);
      cand = next;
      switches++;
    }
    throw new Error("No configured route served this model");
  }

  /** Resolve and enforce context independently from the immutable original
   * request for the actual route/model candidate. */
  private async prepareCandidateRequest(
    candidate: FallbackCandidate,
    originalRequest: ChatRequest
  ): Promise<{ request: ChatRequest; inputTokens: number }> {
    const cfg = getConfig();
    const defaultContext = cfg.get<number>("defaultContextLength", 128_000);
    const globalMaxOutput = cfg.get<number>("maxOutputTokens", 8_192);
    const catalog = this.cachedModels.find(
      (item) => item.entry.routeId === candidate.routeId && item.entry.modelId === candidate.modelId
    );
    const candidateOutput = Math.min(
      catalog?.model.max_output_tokens ?? catalog?.model.max_completion_tokens ?? globalMaxOutput,
      globalMaxOutput
    );
    const settingsKey = modelContextSettingsKey(candidate.routeId, candidate.modelId);
    const stored = readStoredContextSettings(
      this.deps.context.globalState.get<unknown>(MODEL_CONTEXT_SETTINGS_KEY, {})
    );
    const settingsMap = new Map(Object.entries(stored));
    const settings = settingsMap.get(settingsKey);
    const budget = resolveContextBudget({
      providerMaxContext: catalog?.model.context_length,
      fallbackMaxContext: defaultContext,
      settings,
      requestedOutputTokens: candidateOutput,
      safetyMarginTokens: cfg.get<number>("contextSafetyMarginTokens", 1_024),
    });
    if (budget.configuredLimitClamped && settings) {
      const corrected: ModelContextSettings = {
        ...settings,
        maxContextTokens: budget.correctedMaxContextTokens,
      };
      await this.deps.context.globalState.update(MODEL_CONTEXT_SETTINGS_KEY, {
        ...stored,
        [settingsKey]: corrected,
      });
      this.deps.log.warn(
        `Context ceiling reconciled for ${candidate.modelId} @${candidate.routeId}: ${budget.configuredMaxContext}`
      );
    }
    const enforced = enforceContextBudget({
      messages: originalRequest.messages,
      tools: originalRequest.tools,
      budget,
    });
    if (enforced.droppedTools.length > 0) {
      this.deps.log.warn(
        `Context budget dropped ${enforced.droppedTools.length} tool(s) for ${candidate.modelId} @${candidate.routeId}: ${enforced.droppedTools.join(", ")}`
      );
    }
    this.deps.log.info(
      `Context budget model=${candidate.modelId} route=${candidate.routeId} mode=${budget.mode} ` +
      `providerMax=${budget.providerMaxContext} configuredMax=${budget.configuredMaxContext} ` +
      `effectiveMax=${budget.effectiveMaxContext} input=${enforced.accounting.totalInputTokens} ` +
      `available=${budget.availableInputTokens} output=${budget.reservedOutputTokens} ` +
      `margin=${budget.safetyMarginTokens} droppedMessages=${enforced.droppedMessageIndexes.length} droppedTools=${enforced.droppedTools.length}`
    );
    const isReasoning = catalog?.model ? isReasoningModel(catalog.model) : false;
    const candidateRequest: ChatRequest = {
      ...originalRequest,
      model: candidate.modelId,
      messages: enforced.messages,
      tools: enforced.tools.length > 0 ? enforced.tools : undefined,
      max_tokens: budget.reservedOutputTokens,
      reasoning_effort: isReasoning ? originalRequest.reasoning_effort : undefined,
    };
    // Defense in depth at the provider boundary, using the canonical result.
    if (enforced.accounting.totalInputTokens > budget.availableInputTokens) {
      throw new ContextBudgetError("PROTECTED_CONTEXT_OVERFLOW", "Final provider request exceeds context budget");
    }
    return { request: candidateRequest, inputTokens: enforced.accounting.totalInputTokens };
  }

  /** Retries one candidate until it succeeds, cancels, stalls, or exhausts
   * its attempts. Fatal errors (mid-stream or non-transient) propagate. */
  private async tryCandidate(ctx: ChatCandidateContext): Promise<CandidateOutcome> {
    const { cand, token, log, retriesPerServer } = ctx;
    const maxAttempts = Math.max(1, retriesPerServer + 1);
    let attempted = 0;
    let candError: unknown;

    for (; attempted < maxAttempts; attempted++) {
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      const attempt = await this.streamAttempt(ctx);
      if (attempt.kind === "completed") {
        clearRouteCooldown(cand.routeId);
        this.reportUsage(cand, attempt, ctx);
        this.deps.onActivity?.(true, cand.routeId);
        return { kind: "succeeded" };
      }
      if (attempt.kind === "cancelled") return { kind: "cancelled" };
      candError = attempt.error;
      log.warn(
        `Model ${cand.modelId} @${cand.routeId} attempt ${attempted + 1}/${maxAttempts} failed (${formatErrorValue(candError)})`
      );
      if (attempt.stall) {
        markRouteCooldown(cand.routeId, 15_000, 408, "Stream stall");
        ctx.cooledByThisRequest.add(cand.routeId);
        this.deps.onStall?.(cand.routeId);
        break;
      }
      if (attempt.permanent) {
        // Pre-stream 4xx (auth/billing/model rejection): retrying or waiting
        // cannot help this candidate — move to the next one immediately.
        if (errorStatus(candError) === 404) {
          if (OmniRouteChatProvider.pruneModel(cand.routeId, cand.modelId)) {
            log.info(`Pruned stale model ${cand.modelId} from route ${cand.routeId} after 404`);
            void this.refresh();
          }
        }
        break;
      }
      if (attempt.throttle) {
        const delayMs = computeBackoffMs(attempt.error, true, attempted);
        markRouteCooldown(cand.routeId, delayMs, errorStatus(attempt.error) ?? 429, "Admission throttle");
        ctx.cooledByThisRequest.add(cand.routeId);
      } else if (candError instanceof OmniRouteError && candError.phase === "connect") {
        markRouteCooldown(cand.routeId, 10_000, undefined, "Connection failure");
        ctx.cooledByThisRequest.add(cand.routeId);
      }
      if (isExplicitAdmissionCapacityError(candError)) {
        markRouteCooldown(
          cand.routeId,
          15_000,
          errorStatus(candError) ?? 503,
          "Admission capacity unavailable"
        );
        ctx.cooledByThisRequest.add(cand.routeId);
        attempted++;
        break;
      }
      if (attempted + 1 < maxAttempts) {
        await delay(computeBackoffMs(attempt.error, attempt.throttle, attempted), token);
      }
    }

    log.warn(
      `Server ${cand.routeId} gave up after ${attempted} attempt(s) (${formatErrorValue(candError)}); next server`
    );
    return { kind: "failed", error: candError };
  }

  /** Feeds the status bar's live usage readout after a completed stream. */
  private reportUsage(
    cand: FallbackCandidate,
    attempt: Extract<StreamAttemptOutcome, { kind: "completed" }>,
    ctx: ChatCandidateContext
  ): void {
    const reportedInputTokens = finiteNonNegative(attempt.reportedUsage?.inputTokens);
    const reportedOutputTokens = finiteNonNegative(attempt.reportedUsage?.outputTokens);
    const inputTokenProvenance = reportedInputTokens === undefined ? "estimated" : "reported";
    const outputTokenProvenance = reportedOutputTokens === undefined ? "estimated" : "reported";
    const inputTokens =
      reportedInputTokens ?? finiteNonNegative(ctx.inputTokens) ?? 0;
    const outputTokens =
      reportedOutputTokens ?? estimateTokens(attempt.streamed);
    const cachedTokens = subsetTokens(attempt.reportedUsage?.cachedTokens, inputTokens);
    const reasoningTokens = subsetTokens(attempt.reportedUsage?.reasoningTokens, outputTokens);
    const totalTokens =
      finiteNonNegative(attempt.reportedUsage?.totalTokens) ?? (inputTokens + outputTokens);

    emitLanguageModelUsagePart(ctx.progress, {
      inputTokens,
      outputTokens,
      cachedTokens,
      reasoningTokens,
      totalTokens,
    });

    this.deps.onUsage?.({
      routeId: cand.routeId,
      baseUrl: ctx.client?.baseUrl ?? "",
      serverName: ctx.routeName,
      modelName: cand.modelId,
      inputTokens,
      outputTokens,
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      inputTokenProvenance,
      outputTokenProvenance,
    });
  }

  /** One stream attempt: consumes events, reports parts, and classifies the
   * outcome. Cancellation is honored at every checkpoint. */
  private async streamAttempt(ctx: ChatCandidateContext): Promise<StreamAttemptOutcome> {
    const { cand, client, request, progress, token, abort, log } = ctx;
    let streamed = "";
    let reportedAny = false;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    try {
      const consumed = await this.consumeStream(
        client,
        request,
        abort,
        progress,
        token,
        cand.transportPlan,
        () => {
          reportedAny = true;
        }
      );
      streamed = consumed.streamed;
      reportedAny = consumed.reportedAny;
      firstTokenAt = consumed.firstTokenAt;
      if (!reportedAny) {
        log.warn(`Model ${cand.modelId} @${cand.routeId} returned an empty stream; emitting empty text part`);
        progress.report(new vscode.LanguageModelTextPart(""));
      }
      // User cancelled after the first tokens: the request did not complete —
      // don't count it as success or bill usage.
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      const finishedAt = Date.now();
      const outputCount = consumed.reportedUsage?.outputTokens ?? estimateTokens(streamed);
      const cachedSuffix = consumed.reportedUsage?.cachedTokens
        ? `, cached: ${consumed.reportedUsage.cachedTokens}`
        : "";
      log.info(
        `Chat ✓ ${cand.modelId} @${cand.routeId} (TTFT: ${firstTokenAt ? firstTokenAt - startedAt : "n/a"}ms, total: ${finishedAt - startedAt}ms, output: ${outputCount} tokens${cachedSuffix})`
      );
      return { kind: "completed", streamed, startedAt, firstTokenAt, reportedUsage: consumed.reportedUsage };
    } catch (err) {
      return this.concludeStreamFailure(err, reportedAny, ctx);
    }
  }

  /** Consumes one SSE stream, reporting text and tool-call parts as they
   * arrive. Stops early on cancellation. */
  private async consumeStream(
    client: OmniRouteClient,
    request: ChatRequest,
    abort: AbortController,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    transportPlan: FallbackCandidate["transportPlan"],
    onReported: () => void
  ): Promise<{
    streamed: string;
    reportedAny: boolean;
    firstTokenAt: number | undefined;
    reportedUsage?: ChatUsageInfo;
  }> {
    let streamed = "";
    let reportedAny = false;
    let firstTokenAt: number | undefined;
    let reportedUsage: ChatUsageInfo | undefined;
    let inThinking = false;
    const cfg = getConfig();
    const showThinking = cfg.get<string>("showThinking", "nativeOrMarkdown");
    const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
      | (new (text: string) => vscode.LanguageModelResponsePart)
      | undefined;

    for await (const event of client.streamModel(request, abort.signal, transportPlan)) {
      if (token.isCancellationRequested) break;
      if (event.kind === "text") {
        if (inThinking) {
          inThinking = false;
          if (!ThinkingPart && showThinking !== "off") {
            progress.report(new vscode.LanguageModelTextPart("\n\n---\n\n"));
          }
        }
        firstTokenAt ??= Date.now();
        streamed += event.text;
        reportedAny = true;
        onReported();
        progress.report(new vscode.LanguageModelTextPart(event.text));
      } else if (event.kind === "thinking") {
        firstTokenAt ??= Date.now();
        reportedAny = true;
        onReported();
        if (showThinking !== "off") {
          if (ThinkingPart && showThinking === "nativeOrMarkdown") {
            progress.report(new ThinkingPart(event.text));
          } else {
            if (!inThinking) {
              inThinking = true;
              progress.report(new vscode.LanguageModelTextPart("> 💭 *Thinking...*\n> \n> "));
            }
            const formatted = event.text.replace(/\n/g, "\n> ");
            progress.report(new vscode.LanguageModelTextPart(formatted));
          }
        }
      } else if (event.kind === "usage") {
        reportedUsage = {
          ...reportedUsage,
          ...event.usage,
          inputTokens: event.usage.inputTokens ?? reportedUsage?.inputTokens,
          outputTokens: event.usage.outputTokens ?? reportedUsage?.outputTokens,
          cachedTokens: event.usage.cachedTokens ?? reportedUsage?.cachedTokens,
          reasoningTokens: event.usage.reasoningTokens ?? reportedUsage?.reasoningTokens,
          totalTokens: event.usage.totalTokens ?? reportedUsage?.totalTokens,
        };
        if (
          typeof reportedUsage.inputTokens === "number" &&
          typeof reportedUsage.outputTokens === "number"
        ) {
          emitLanguageModelUsagePart(progress, {
            inputTokens: reportedUsage.inputTokens,
            outputTokens: reportedUsage.outputTokens,
            cachedTokens: reportedUsage.cachedTokens,
            reasoningTokens: reportedUsage.reasoningTokens,
            totalTokens: reportedUsage.totalTokens,
          });
        }
      } else {
        const toolEvent = event as { id: string; name: string; args: string };
        if (toolEvent.name) {
          reportedAny = true;
          onReported();
          progress.report(
            new vscode.LanguageModelToolCallPart(toolEvent.id, toolEvent.name, parseToolCallArgs(toolEvent, this.deps.log))
          );
        }
      }
    }
    return { streamed, reportedAny, firstTokenAt, reportedUsage };
  }

  /** Classifies a failed attempt: cancellation → cancelled, mid-stream →
   * fatal (throw), pre-stream permanent rejection (4xx) → failed+permanent
   * so the chain advances to the next candidate without retrying, anything
   * transient → retryable with stall/throttle flags. */
  private concludeStreamFailure(
    err: unknown,
    reportedAny: boolean,
    ctx: ChatCandidateContext
  ): StreamAttemptOutcome {
    const { cand, token, log } = ctx;
    if (token.isCancellationRequested) {
      return { kind: "cancelled" };
    }
    if (reportedAny) {
      this.deps.onActivity?.(false, cand.routeId);
      log.error(`Chat request failed mid-stream: ${formatErrorValue(err)}`);
      throw err;
    }
    const status = errorStatus(err);
    // Network-level failures (no HTTP status, e.g. `fetch failed`) are
    // treated as transient so the server can be re-attempted. A pre-stream
    // HTTP rejection is definitive for THIS candidate — but with per-route
    // credentials another route can still serve, so it must fail over
    // instead of killing the whole chain.
    const transient = status === undefined || isTransientHttpError(status);
    if (!transient) {
      this.deps.onActivity?.(false, cand.routeId);
      log.warn(
        `Chat request rejected by ${cand.routeId} (HTTP ${status}): ${formatErrorValue(err)} — failing over`
      );
      return { kind: "failed", error: err, stall: false, throttle: false, permanent: true };
    }
    return {
      kind: "failed",
      error: err,
      stall: err instanceof OmniRouteError && err.stall,
      throttle: status === 503 || status === 429 || isThrottleError(err),
    };
  }

  /** Reports the final failure to extension state, then lets VS Code surface
   * an actionable message (what to do next) instead of the raw upstream text. */
  private reportChatFailure(args: {
    routeId: string | undefined;
    routeName: string | undefined;
    fallbacksUsed: number;
    err: unknown;
    modelId: string;
    serverCount: number;
    candidateCount: number;
  }): never {
    const { routeId, routeName, fallbacksUsed, err, candidateCount, modelId } = args;
    const actionable = actionableFailureMessage(err, modelId, routeName);
    this.deps.onActivity?.(false, routeId);
    this.deps.log.error(`Chat request failed after ${candidateCount} model(s): ${formatErrorValue(err)}`);
    this.deps.onRequestEnd?.(false, actionable, fallbacksUsed);

    const status = errorStatus(err);
    const LMError = (vscode as unknown as Record<string, unknown>).LanguageModelError as
      | {
          NotFound?: (msg?: string) => Error;
          NoPermissions?: (msg?: string) => Error;
          Blocked?: (msg?: string) => Error;
        }
      | undefined;

    if (LMError) {
      if (status === 401 || status === 403) {
        throw LMError.NoPermissions?.(actionable) ?? new Error(actionable);
      }
      if (status === 404) {
        throw LMError.NotFound?.(actionable) ?? new Error(actionable);
      }
      if (status === 429) {
        throw LMError.Blocked?.(actionable) ?? new Error(actionable);
      }
    }

    if (err instanceof OmniRouteError) {
      throw new OmniRouteError(
        actionable,
        err.status,
        err.stall,
        err.phase,
        err.endpoint,
        err.latencyMs,
        err.retryAfterMs,
        err.code
      );
    }
    throw new Error(actionable);
  }

  // ── Token counting ──────────────────────────────────────────────────────

  async provideTokenCount(
    _model: OmniModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return estimateTokens(text);
  }
}

/** Emits a LanguageModelDataPart with MIME "usage" to inform VS Code Copilot of token consumption. */
export function emitLanguageModelUsagePart(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  }
): void {
  try {
    const DataPart = (vscode as unknown as Record<string, unknown>).LanguageModelDataPart as
      | (new (data: Uint8Array, mimeType: string) => vscode.LanguageModelResponsePart)
      | undefined;
    if (!DataPart) return;

    const promptTokens = Math.max(0, Math.round(usage.inputTokens));
    const completionTokens = Math.max(0, Math.round(usage.outputTokens));
    const totalTokens = Math.max(
      0,
      Math.round(usage.totalTokens ?? (promptTokens + completionTokens))
    );

    const payload: Record<string, unknown> = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };

    if (usage.cachedTokens !== undefined && Number.isFinite(usage.cachedTokens)) {
      payload.prompt_tokens_details = {
        cached_tokens: Math.max(0, Math.round(usage.cachedTokens)),
      };
    }
    if (usage.reasoningTokens !== undefined && Number.isFinite(usage.reasoningTokens)) {
      payload.completion_tokens_details = {
        reasoning_tokens: Math.max(0, Math.round(usage.reasoningTokens)),
      };
    }

    payload.inputTokens = promptTokens;
    payload.outputTokens = completionTokens;
    payload.totalTokens = totalTokens;

    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    progress.report(new DataPart(bytes, "usage"));
  } catch {
    // Non-fatal if host environment rejects data part
  }
}
