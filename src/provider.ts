import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { OmniRouteClient, OmniRouteError, describeFetchError, formatErrorValue, isThrottleError, isTransientHttpError } from "./client";
import { isReasoningModel, resolveReasoningEffort } from "./reasoning";

import { EXPOSE_TO_AGENTS_WINDOW_SETTING, expandForAgentsWindow } from "./agentsWindow";
import { selectChatModels } from "./catalogFilter";
import { transportSurfaceLabel } from "./supportedEndpoints";
import { estimateTokens, toolCallSummary, toOpenAiMessages, toOpenAiTools } from "./convert";
import { containsVisibleText } from "./visibleText";
import {
  applyTransportPreference,
  buildCatalog,
  cachedLoadRoutes,
  clearRouteCooldown,
  getClientForRoute,
  isRouteInCooldown,
  markRouteCooldown,
  pickFallbackCandidates,
  transportPlanForModel,
} from "./routes";
import type { ChatRequest, ChatUsageInfo, OmniRouteModel, TransportPreference } from "./types";
import type { CatalogModel, FallbackCandidate, FallbackMode, RouteCatalog } from "./routes";
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

function formatContextLength(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return `${tokens}`;
}

/** Builds a bounded, case-insensitive literal model filter. Treating the
 * workspace setting as data avoids executing user-controlled regular
 * expressions and their potential catastrophic backtracking. */
function compileModelFilter(filterRaw: string): ((modelId: string) => boolean) | undefined {
  const needle = filterRaw.slice(0, 200).toLocaleLowerCase();
  if (!needle) return undefined;
  return (modelId: string) => modelId.toLocaleLowerCase().includes(needle);
}

/** Small non-abortable pause between fallback attempts to avoid hammering a
 * busy server. Kept short; cancellation is re-checked on the next iteration. */
function delay(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      sub?.dispose();
      resolve();
    }, ms);
    let sub: vscode.Disposable | undefined;
    if (token) {
      sub = token.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}


/** HTTP status code carried by an OmniRouteError, if any. */
function errorStatus(err: unknown): number | undefined {
  return err instanceof OmniRouteError ? err.status : undefined;
}

/** Whether a failed candidate rejected request admission for this route. */
function isAdmissionSaturationError(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 429 || status === 503 || isThrottleError(err);
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

/** True when the entire fallback chain failed exclusively due to admission
 * saturation — every route returned 429/503 with throttle indicators. In this
 * case a global cooldown + short wait may let the upstream recover, so the
 * caller can retry the full chain once more before giving up. */
function allFailuresWereAdmissionSaturated(outcome: ChatPlanOutcome): boolean {
  if (outcome.kind !== "failed") return false;
  return isAdmissionSaturationError(outcome.error);
}

/** Base retry delay (ms) when every route reports admission saturation.
 * Short enough to feel responsive; long enough for upstream capacity to
 * recycle. Actual delay is jittered [BASE, BASE+JITTER] to prevent
 * concurrent requests from retrying in lockstep (thundering herd). */
const GLOBAL_ADMISSION_RETRY_BASE_MS = 2_500;
const GLOBAL_ADMISSION_RETRY_JITTER_MS = 2_000;

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

/** Jittered global admission retry delay. Prevents concurrent requests from
 * retrying in lockstep (thundering herd) by randomizing within
 * [BASE, BASE+JITTER]. Accepts an optional retry index (0-based) for
 * progressive backoff: each subsequent retry adds BASE_MS extra delay so
 * the upstream has more time to recycle capacity. */
function jitteredAdmissionRetryMs(retryIndex = 0): number {
  const progressiveBase = GLOBAL_ADMISSION_RETRY_BASE_MS * (retryIndex + 1);
  return progressiveBase + crypto.randomInt(GLOBAL_ADMISSION_RETRY_JITTER_MS);
}

/** Parses a tool-call's JSON args defensively; `{}` on malformed input. */
function parseToolCallArgs(
  event: { args: string; name: string },
  log: vscode.LogOutputChannel
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    log.warn(`Tool call ${event.name} had invalid JSON args; sending {}`);
    return {};
  }
}

/** Everything needed to run the chat fallback chain for one request. */
interface ChatPlan {
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

/** Max times the full candidate chain is retried when every route reports
 * admission saturation. Two extra passes (after the initial failure) cover
 * typical upstream capacity recycling windows (server says "Retry shortly"
 * which may need 3-6 s). Each pass uses progressively longer jittered delays
 * to avoid thundering-herd amplification. */
const MAX_GLOBAL_ADMISSION_RETRIES = 2;

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
  | { kind: "failed"; routeId: string | undefined; fallbacksUsed: number; error: unknown };

export class OmniRouteChatProvider
  implements vscode.LanguageModelChatProvider<OmniModelInfo>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

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
    options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
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

    const ttlMinutes = getConfig().get<number>("modelCacheTtlMinutes", 15);
    const isManualOnly = ttlMinutes <= 0;
    const ttlMs = isManualOnly ? Number.POSITIVE_INFINITY : ttlMinutes * 60_000;
    const isFresh = Date.now() - OmniRouteChatProvider.sharedLastCatalogFetch < ttlMs;

    if (OmniRouteChatProvider.sharedCachedModels.length > 0 && isFresh) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels, validRouteIds);
    }

    const activeRoutes = routes.slice(0, 10);
    const refreshGeneration = OmniRouteChatProvider.sharedRefreshGeneration;

    const segments: RouteCatalog[] = await Promise.all(
      activeRoutes.map(async (r) => {
        let fetchP = OmniRouteChatProvider.sharedRouteFetchPromises.get(r.id);
        if (!fetchP) {
          fetchP = (async () => {
            try {
              const models = await getClientForRoute(r, this.deps.log).listModels();
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
      if (!options.silent && !this.filterRouteId) void this.offerConnectionHelp();
      return [];
    }

    this.deps.log.info(
      `Listed ${infos.length} models for vendor (filterRouteId: ${this.filterRouteId ?? "all"}, total cached: ${catalog.length})`
    );
    return infos;
  }

  private toModelInfos(catalog: CatalogModel[], validRouteIds?: Set<string>): OmniModelInfo[] {
    const cfg = getConfig();
    const maxOutput = cfg.get<number>("maxOutputTokens", 16384);
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
    const contextLength = model.context_length ?? defaultContext;
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

    const ctxTag = `${formatContextLength(contextLength)} ctx`;
    const capsTags: string[] = [ctxTag];
    if (supportsReasoning) capsTags.push("extended thinking");
    if (caps.vision === true) capsTags.push("vision");

    // Per-model API-surface indication, derived from the same authoritative
    // transport plan used for streaming.
    const surfaceTags = transportSurfaceLabel(transportPlanForModel(model));
    capsTags.push(surfaceTags);

    const routeLabel = c.entry.routeName || "OmniCopilot";
    const tooltip = `${routeLabel} · ${model.id} (${capsTags.join(" · ")})`;

    return {
      id: c.entry.prefixedId,
      name,
      family: model.owned_by || "omniroute",
      version: "1.0.0",
      detail: isCombo ? `combo · ${surfaceTags}` : (c.entry.routeName || model.owned_by),
      tooltip,
      maxInputTokens: Math.max(contextLength - maxOutputTokens, 1024),
      maxOutputTokens,
      capabilities: {
        toolCalling: caps.tool_calling !== false,
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

  async provideLanguageModelChatResponse(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const log = this.deps.log;
    const request = this.buildChatRequest(model, messages, options, log);
    const plan = await this.resolveChatPlan(model, request, options, log);

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    // Estimate the input side of the request for the usage readout.
    const inputTokens = messages.reduce((n, msg) => n + estimateTokens(msg), 0);

    try {
      await this.executeChatPlan(plan, request, inputTokens, progress, token, abort);
    } finally {
      cancelSub.dispose();
    }
  }

  /** Builds the wire request for the selected model: OpenAI-compatible chat
   * payload with the user's tool cap, mandatory tool mode and temperature. */
  private buildChatRequest(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    log: vscode.LogOutputChannel
  ): ChatRequest {
    const request: ChatRequest = {
      model: model.omniModelId,
      messages: toOpenAiMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      tools: this.capTools(options.tools, log),
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

  /** Caps the tool list VS Code offered us, saving context: `maxTools <= 0`
   * means "send every tool"; a positive value is an explicit hard cap. */
  private capTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
    log: vscode.LogOutputChannel
  ): ReturnType<typeof toOpenAiTools> {
    const allTools = toOpenAiTools(tools);
    if (!allTools?.length) return allTools;
    const maxTools = getConfig().get<number>("maxTools", 0);
    if (maxTools > 0 && allTools.length <= maxTools) return allTools;
    if (maxTools > 0) {
      log.warn(`Limiting tools from ${allTools.length} to ${maxTools}`);
      return allTools.slice(0, maxTools);
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
      cfg.get<number>("idleTimeoutSeconds", 30) * 1000;
    const compressionOverride = cfg.get<string>("compressionOverride", "serverDefault");
    const clientByRoute = new Map(
      routes.map((r) => [r.id, getClientForRoute(r, this.deps.log, firstByteTimeoutMs, compressionOverride, streamIdleTimeoutMs)])
    );
    const nameByRoute = new Map(routes.map((r) => [r.id, r.name]));

    const primaryCatalogModel = this.cachedModels.find((c) => c.entry.prefixedId === model.id);
    const primaryEntry = primaryCatalogModel?.entry;
    if (!primaryEntry) {
      this.deps.log.warn(
        `Primary model not found in catalog: ${model.id} (${this.cachedModels.length} cached)`
      );
    }
    // User-selected transport override: `auto` keeps the catalog-derived plan;
    // a concrete value narrows every candidate to that single protocol.
    const preference = getConfig().get<TransportPreference>("transport", "auto");
    // Always include all models as fallback candidates. Route-affinity
    // sorting ensures same-route models are tried first; cross-route
    // models serve as a last resort when the primary route is
    // admission-saturated (503). This prevents a single route's capacity
    // exhaustion from blocking the user entirely when other routes are
    // available.
    const fallbackCatalog = this.cachedModels;
    const fallbacks = (primaryEntry
      ? pickFallbackCandidates(
          primaryEntry,
          fallbackCatalog,
          Boolean(options.tools?.length),
          getConfig().get<FallbackMode>("fallbackMode", "sameModel")
        )
      : []
    ).map((candidate) => ({
      ...candidate,
      transportPlan: applyTransportPreference(candidate.transportPlan, preference),
    }));
    // The prefixedId is the source of truth for what the user selected.
    // Resolve the route from the catalog entry, NOT from model.routeId which
    // can be stale or point to a different server.
    if (!primaryEntry && (!model.routeId || !model.omniModelId)) {
      throw new OmniRouteError(`Model ${model.id} is not available or not properly configured`, undefined);
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

    // Preserve fallback quality tiers while applying health within each tier.
    // An exact same-model route may bypass a cooling primary; same-family and
    // arbitrary substitutions never run before the selected model tier.
    const knownOnline = this.deps.getOnlineRouteIds?.() ?? new Set<string>();
    const primaryFamily = primary.modelId.split("/")[0];
    const qualityTier = (candidate: FallbackCandidate): number => {
      if (candidate.modelId === primary.modelId) return 0;
      if (candidate.modelId.split("/")[0] === primaryFamily) return 1;
      return 2;
    };
    const candidates = [primary, ...fallbacks].sort((a, b) => {
      // Quality tier first: same-model > same-family > any other.
      const tierDifference = qualityTier(a) - qualityTier(b);
      if (tierDifference !== 0) return tierDifference;
      // Then cooldown: healthy routes before cooling ones.
      const aCooling = isRouteInCooldown(a.routeId) ? 1 : 0;
      const bCooling = isRouteInCooldown(b.routeId) ? 1 : 0;
      if (aCooling !== bCooling) return aCooling - bCooling;
      // Route affinity: same-route before cross-route when quality and
      // health are equal. Cross-route models serve as a last resort
      // when the primary route is admission-saturated (503).
      const aSameRoute = a.routeId === primary.routeId ? 0 : 1;
      const bSameRoute = b.routeId === primary.routeId ? 0 : 1;
      if (aSameRoute !== bSameRoute) return aSameRoute - bSameRoute;
      if (knownOnline.size > 0) {
        const aOnline = knownOnline.has(a.routeId) ? 0 : 1;
        const bOnline = knownOnline.has(b.routeId) ? 0 : 1;
        return aOnline - bOnline;
      }
      return 0;
    });

    const serverCount = new Set(candidates.map((c) => c.routeId)).size;

    // Pre-compute the fallback chain readout: building it inline would nest a
    // template literal inside another one (Sonar S4624).
    const fallbackSummary = candidates.slice(1).map((f) => `${f.routeId}:${f.modelId}`).join(", ");
    log.info(
      `Chat → ${primary.modelId} @${primary.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbackSummary}` : "")
    );

    const retriesPerServer = getConfig().get<number>("retriesPerServer", 1);
    return {
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
    inputTokens: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abort: AbortController
  ): Promise<void> {
    this.deps.onRequestStart?.(plan.candidates[0]?.routeId, plan.modelId);
    let requestSettled = false;

    try {
      let outcome = await this.runChatCandidates(plan, request, inputTokens, progress, token, abort);

      // Global admission-saturation retry: when every route returns 429/503
      // with capacity indicators (chat_admission_busy, etc.), the upstream may
      // recover within a few seconds. Clear only cooldowns set by THIS
      // request (tracked in `cooledByThisRequest`) and retry the full
      // chain once before giving up. The delay is jittered to prevent
      // concurrent requests from retrying in lockstep (thundering herd).
      if (outcome.kind === "failed" && allFailuresWereAdmissionSaturated(outcome)) {
        for (let retry = 0; retry < MAX_GLOBAL_ADMISSION_RETRIES; retry++) {
          if (token.isCancellationRequested) break;
          const retryDelayMs = jitteredAdmissionRetryMs(retry);
          this.deps.log.warn(
            `[ADMISSION RETRY] All routes admission-saturated for ${plan.modelId}; ` +
            `waiting ${retryDelayMs}ms (jittered) before retry pass ${retry + 1}/${MAX_GLOBAL_ADMISSION_RETRIES}`
          );
          await delay(retryDelayMs, token);
          if (token.isCancellationRequested) break;
          // Clear only cooldowns that THIS request established, not cooldowns
          // set by other concurrent requests. This preserves backpressure from
          // other providers while allowing this request to retry.
          for (const routeId of plan.cooledByThisRequest) {
            clearRouteCooldown(routeId);
          }
          outcome = await this.runChatCandidates(plan, request, inputTokens, progress, token, abort);
          if (outcome.kind !== "failed" || !allFailuresWereAdmissionSaturated(outcome)) {
            break; // success, cancellation, or a different error — stop retrying
          }
        }
      }

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
    inputTokens: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    abort: AbortController
  ): Promise<ChatPlanOutcome> {
    const candidates = plan.candidates;
    const saturatedEndpoints = new Set<string>();
    let lastError: unknown;

    for (let i = 0; i < candidates.length;) {
      const cand = candidates.slice(i, i + 1).pop();
      if (!cand) break;
      if (token.isCancellationRequested) return { kind: "cancelled", fallbacksUsed: i };
      const endpoint = plan.clientByRoute.get(cand.routeId)?.baseUrl ?? `route:${cand.routeId}`;
      if (saturatedEndpoints.has(endpoint)) {
        this.deps.log.info(
          `Skipping fallback ${cand.modelId} @${cand.routeId}: endpoint rejected admission earlier in this request`
        );
        i++;
        continue;
      }
      const client = plan.clientByRoute.get(cand.routeId);
      if (!client) {
        lastError = new OmniRouteError(`Route ${cand.routeId} is not configured`, undefined);
        i++;
        continue;
      }
      const outcome = await this.tryCandidate({
        cand,
        client,
        i,
        request,
        inputTokens,
        progress,
        token,
        abort,
        log: this.deps.log,
        routeName: plan.nameByRoute.get(cand.routeId) ?? cand.routeId,
        retriesPerServer: plan.retriesPerServer,
        cooledByThisRequest: plan.cooledByThisRequest,
      });
      if (outcome.kind === "succeeded" || outcome.kind === "cancelled") {
        return { kind: outcome.kind, fallbacksUsed: i };
      }
      lastError = outcome.error;
      if (isAdmissionSaturationError(outcome.error)) saturatedEndpoints.add(endpoint);
      // P2-01: a global rejection (VALID_*/COMBO_*/malformed body) is identical
      // for every candidate — replaying it only burns fetches. Fail immediately
      // with the real error instead of advancing the chain.
      if (isGlobalRequestRejection(outcome.error)) {
        this.deps.log.error(
          `Global request rejected by ${cand.routeId}: ${formatErrorValue(outcome.error)} — not replaying on remaining ${candidates.length - 1 - i} candidate(s)`
        );
        return { kind: "failed", routeId: cand.routeId, fallbacksUsed: i, error: outcome.error };
      }
      const lastAttemptedIndex = this.advanceAfterCandidateFailure(plan, cand, outcome.error, i);
      if (lastAttemptedIndex >= candidates.length - 1) {
        return {
          kind: "failed",
          routeId: cand.routeId,
          fallbacksUsed: lastAttemptedIndex,
          error: outcome.error,
        };
      }
      i = lastAttemptedIndex + 1;
    }

    return {
      kind: "failed",
      routeId: candidates.at(0)?.routeId,
      fallbacksUsed: lastError === undefined ? candidates.length : candidates.length - 1,
      error: lastError ?? new OmniRouteError("No configured route served this model", undefined),
    };
  }

  /** Skips redundant same-route fallbacks after admission throttling. */
  private advanceAfterCandidateFailure(
    plan: ChatPlan,
    candidate: FallbackCandidate,
    error: unknown,
    index: number
  ): number {
    const status = errorStatus(error);
    const isThrottle = status === 503 || status === 429 || isThrottleError(error);
    let nextIndex = index;
    if (isThrottle) {
      nextIndex = this.skipSaturatedRouteCandidates(plan.candidates, candidate.routeId, nextIndex, status);
    }
    return nextIndex;
  }

  /** Skips other models on a route that has already rejected admission. */
  private skipSaturatedRouteCandidates(
    candidates: FallbackCandidate[],
    routeId: string,
    index: number,
    status: number | undefined
  ): number {
    let nextIndex = index;
    let nextCandidate = candidates.at(nextIndex + 1);
    while (nextCandidate?.routeId === routeId) {
      this.deps.log.info(
        `Skipping fallback ${nextCandidate.modelId} @${routeId}: server is admission-saturated (HTTP ${status ?? "503/429"})`
      );
      nextIndex++;
      nextCandidate = candidates.at(nextIndex + 1);
    }
    return nextIndex;
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
        { ...request, model: cand.modelId },
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
      if (!consumed.hasVisibleText && consumed.toolNames.length > 0) {
        progress.report(new vscode.LanguageModelTextPart(toolCallSummary(consumed.toolNames)));
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
    hasVisibleText: boolean;
    toolNames: string[];
    reportedUsage?: ChatUsageInfo;
  }> {
    let streamed = "";
    let reportedAny = false;
    let firstTokenAt: number | undefined;
    let hasVisibleText = false;
    const toolNames: string[] = [];
    let reportedUsage: ChatUsageInfo | undefined;
    for await (const event of client.streamModel(request, abort.signal, transportPlan)) {
      if (token.isCancellationRequested) break;
      if (event.kind === "text") {
        firstTokenAt ??= Date.now();
        streamed += event.text;
        hasVisibleText ||= containsVisibleText(event.text);
        reportedAny = true;
        onReported();
        progress.report(new vscode.LanguageModelTextPart(event.text));
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
      } else {
        const toolEvent = event as { id: string; name: string; args: string };
        if (toolEvent.name) {
          if (!toolNames.includes(toolEvent.name)) toolNames.push(toolEvent.name);
          reportedAny = true;
          onReported();
          progress.report(
            new vscode.LanguageModelToolCallPart(toolEvent.id, toolEvent.name, parseToolCallArgs(toolEvent, this.deps.log))
          );
        }
      }
    }
    return { streamed, reportedAny, firstTokenAt, hasVisibleText, toolNames, reportedUsage };
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

  /** Reports the final failure to extension state, then lets VS Code surface it. */
  private reportChatFailure(args: {
    routeId: string | undefined;
    fallbacksUsed: number;
    err: unknown;
    modelId: string;
    serverCount: number;
    candidateCount: number;
  }): never {
    const { routeId, fallbacksUsed, err, candidateCount } = args;
    this.deps.onActivity?.(false, routeId);
    this.deps.log.error(`Chat request failed after ${candidateCount} model(s): ${formatErrorValue(err)}`);
    this.deps.onRequestEnd?.(false, describeFetchError(err), fallbacksUsed);
    throw err;
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
