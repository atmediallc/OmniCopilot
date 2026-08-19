import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { OmniRouteClient, OmniRouteError, describeFetchError, formatErrorValue, isTransientHttpError, isThrottleError } from "./client";

import { estimateTokens, toOpenAiMessages, toOpenAiTools } from "./convert";
import { buildCatalog, cachedLoadRoutes, getClientForRoute, pickFallbackCandidates } from "./routes";
import type { ChatRequest } from "./types";
import type { CatalogModel, FallbackCandidate, FallbackMode, RouteCatalog } from "./routes";

interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
  routeId: string;
}

export interface ProviderDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  /** Called whenever a request round-trip settles, with success flag —
   * feeds the status bar without extra polling. */
  onActivity?: (ok: boolean, routeId?: string) => void;
  /** Live token usage while a chat response streams — feeds the status bar. */
  onUsage?: (usage: { routeId?: string; baseUrl?: string; serverName: string; modelName: string; inputTokens: number; outputTokens: number }) => void;
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
  return vscode.workspace.getConfiguration("omnicopilot");
}

/** Compiles the user's model filter regex. A malformed or overly long pattern
 * falls back to a safe literal substring match so the picker still works. */
function compileModelFilter(filterRaw: string): RegExp | undefined {
  if (!filterRaw) return undefined;
  try {
    if (filterRaw.length > 200) throw new Error("Filter too long");
    return new RegExp(filterRaw, "i");
  } catch {
    // invalid or overly complex regex → fall back to safe escaped substring matching
    const needle = filterRaw.slice(0, 200).toLowerCase();
    return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), "i");
  }
}

/** Small non-abortable pause between fallback attempts to avoid hammering a
 * busy server. Kept short; cancellation is re-checked on the next iteration. */
function delay(ms: number, token?: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (token) {
      token.onCancellationRequested(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

/** Builds a user-facing failure message, separating upstream capacity/rate-limit
 * (503/429 — retry shortly) from connection/config problems (check your server). */
function describeFinalFailure(modelId: string, serverCount: number, err: unknown): string {
  const isThrottle =
    err instanceof OmniRouteError && (err.status === 503 || err.status === 429 || isThrottleError(err));
  if (isThrottle) {
    return vscode.l10n.t(
      "OmniRoute: model {0} is temporarily unavailable on all {1} server(s). The upstream is at capacity or rate-limited (HTTP {2}); retry in a moment or pick another model.",
      modelId,
      String(serverCount),
      String(err instanceof OmniRouteError && err.status ? err.status : "503/429")
    );
  }
  const reason = err instanceof OmniRouteError ? err.message : formatErrorValue(err);
  return vscode.l10n.t(
    "OmniRoute: the model {0} couldn't be reached on any of {1} server(s). Last error: {2}. Check the server's proxy/API key in the panel or pick another model.",
    modelId,
    String(serverCount),
    reason
  );
}

/** HTTP status code carried by an OmniRouteError, if any. */
function errorStatus(err: unknown): number | undefined {
  return err instanceof OmniRouteError ? err.status : undefined;
}

/** Jittered delay between retries. Honors the upstream's Retry-After header
 * when present (capped at 30s) so a misbehaving server can't stall a request. */
function computeBackoffMs(err: unknown, isThrottle: boolean, attempted: number): number {
  const retryAfterMs = err instanceof OmniRouteError ? err.retryAfterMs : undefined;
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  const baseDelay = isThrottle ? 1500 + crypto.randomInt(1000) : 250;
  const maxDelay = isThrottle ? 8000 : 2000;
  const multiplier = isThrottle ? 1.5 : 2;
  return Math.min(maxDelay, baseDelay * Math.pow(multiplier, attempted));
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
  admissionRetries: number;
}

/** Shared context for streaming against one fallback candidate. */
interface ChatCandidateContext {
  cand: FallbackCandidate;
  client: OmniRouteClient;
  i: number;
  request: ChatRequest;
  routeName: string;
  inputTokens: number;
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  token: vscode.CancellationToken;
  abort: AbortController;
  log: vscode.LogOutputChannel;
  retriesPerServer: number;
  admissionRetries: number;
}

/** Outcome of a single stream attempt. */
type StreamAttemptOutcome =
  | { kind: "completed"; streamed: string; startedAt: number; firstTokenAt: number | undefined }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown; stall: boolean; throttle: boolean };

/** Outcome of a whole candidate (all of its retries). */
type CandidateOutcome =
  | { kind: "succeeded" }
  | { kind: "cancelled" }
  | { kind: "failed"; error: unknown };

export class OmniRouteChatProvider
  implements vscode.LanguageModelChatProvider<OmniModelInfo>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private static readonly sharedRouteCatalogs = new Map<string, RouteCatalog>();
  private static readonly sharedRouteFetchPromises = new Map<string, Promise<RouteCatalog>>();
  private static sharedCachedModels: CatalogModel[] = [];
  private static sharedLastCatalogFetch = 0;
  private static readonly routeFailures = new Map<string, number>();
  private static readonly routeCooldowns = new Map<string, number>();
  private static readonly ROUTE_FAILURE_LIMIT = 2;
  private static readonly ROUTE_COOLDOWN_MS = 60_000;
  private static readonly CACHE_STATE_KEY = "omnicopilot.cachedCatalog.v1";
  private static readonly CACHE_TIME_KEY = "omnicopilot.cachedCatalogTime.v1";

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
        context_length: c.model.context_length,
        max_completion_tokens: c.model.max_completion_tokens,
        capabilities: {
          tool_calling: c.model.capabilities?.tool_calling,
          vision: c.model.capabilities?.vision,
        },
      },
    }));
    await context.globalState.update(OmniRouteChatProvider.CACHE_STATE_KEY, slim);
    await context.globalState.update(OmniRouteChatProvider.CACHE_TIME_KEY, Date.now());
  }

  /** Drops catalog segments whose routes are no longer configured, so model
   * discovery never serves stale entries. */
  private static pruneStaleRouteCatalogs(validRouteIds: Set<string>): void {
    for (const key of Array.from(OmniRouteChatProvider.sharedRouteCatalogs.keys())) {
      if (!validRouteIds.has(key)) {
        OmniRouteChatProvider.sharedRouteCatalogs.delete(key);
      }
    }
  }

  constructor(
    private readonly deps: ProviderDeps,
    public readonly filterRouteId?: string
  ) {}

  get cachedModels(): CatalogModel[] {
    return OmniRouteChatProvider.sharedCachedModels;
  }

  private isRouteCoolingDown(routeId: string): boolean {
    const until = OmniRouteChatProvider.routeCooldowns.get(routeId) ?? 0;
    if (until <= Date.now()) {
      OmniRouteChatProvider.routeCooldowns.delete(routeId);
      return false;
    }
    return true;
  }

  private recordRouteSuccess(routeId: string): void {
    OmniRouteChatProvider.routeFailures.delete(routeId);
    OmniRouteChatProvider.routeCooldowns.delete(routeId);
  }

  private recordRouteFailure(routeId: string): void {
    const failures = (OmniRouteChatProvider.routeFailures.get(routeId) ?? 0) + 1;
    OmniRouteChatProvider.routeFailures.set(routeId, failures);
    if (failures >= OmniRouteChatProvider.ROUTE_FAILURE_LIMIT) {
      OmniRouteChatProvider.routeCooldowns.set(
        routeId,
        Date.now() + OmniRouteChatProvider.ROUTE_COOLDOWN_MS
      );
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** Re-query the catalog and tell VS Code the model list changed. */
  async refresh(): Promise<void> {
    OmniRouteChatProvider.sharedRouteCatalogs.clear();
    OmniRouteChatProvider.sharedRouteFetchPromises.clear();
    OmniRouteChatProvider.sharedCachedModels = [];
    OmniRouteChatProvider.sharedLastCatalogFetch = 0;
    await this.deps.context.globalState.update(OmniRouteChatProvider.CACHE_STATE_KEY, []);
    await this.deps.context.globalState.update(OmniRouteChatProvider.CACHE_TIME_KEY, 0);
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
    OmniRouteChatProvider.pruneStaleRouteCatalogs(validRouteIds);

    const ttlMinutes = getConfig().get<number>("modelCacheTtlMinutes", 15);
    const isManualOnly = ttlMinutes <= 0;
    const ttlMs = isManualOnly ? Number.POSITIVE_INFINITY : ttlMinutes * 60_000;
    const isFresh = Date.now() - OmniRouteChatProvider.sharedLastCatalogFetch < ttlMs;

    if (OmniRouteChatProvider.sharedCachedModels.length > 0 && isFresh) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels, validRouteIds);
    }

    const activeRoutes = routes.slice(0, 10);

    const segments: RouteCatalog[] = await Promise.all(
      activeRoutes.map(async (r) => {
        let fetchP = OmniRouteChatProvider.sharedRouteFetchPromises.get(r.id);
        if (!fetchP) {
          fetchP = (async () => {
            try {
              const models = await getClientForRoute(r, this.deps.log).listModels();
              this.deps.onActivity?.(true, r.id);
              this.deps.log.info(`Route "${r.name}" (${r.baseUrl}) model discovery succeeded: ${models.length} model(s)`);
              return { routeId: r.id, name: r.name, models };
            } catch (err) {
              this.deps.onActivity?.(false, r.id);
              this.deps.log.warn(
                `Route "${r.name}" (${r.baseUrl}) model discovery failed: ${formatErrorValue(err)}`
              );
              return { routeId: r.id, name: r.name, models: [] };
            }
          })().finally(() => {
            OmniRouteChatProvider.sharedRouteFetchPromises.delete(r.id);
          });
          OmniRouteChatProvider.sharedRouteFetchPromises.set(r.id, fetchP);
        }
        return fetchP;
      })
    );

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
    return infos;
  }

  /** Route/filter gating for one catalog entry: must belong to a valid route
   * (when given), match this provider's route (when scoped), carry an id, and
   * pass the user's model filter. */
  private isModelEligible(
    c: CatalogModel,
    filter: RegExp | undefined,
    validRouteIds?: Set<string>
  ): boolean {
    if (validRouteIds && !validRouteIds.has(c.entry.routeId)) return false;
    if (this.filterRouteId && c.entry.routeId !== this.filterRouteId) return false;
    const model = c.model;
    if (!model?.id) return false;
    if (filter && !filter.test(model.id)) return false;
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
    const maxOutputTokens = Math.min(model.max_completion_tokens ?? maxOutput, maxOutput);
    const caps = model.capabilities ?? {};
    const isCombo = model.owned_by === "combo";

    const displayName = model.display_name?.trim() || model.id;

    return {
      id: c.entry.prefixedId,
      name: `${displayName} (${c.entry.routeName})`,
      family: model.owned_by || "omniroute",
      version: "1.0.0",
      detail: isCombo ? "combo" : model.owned_by,
      tooltip: `OmniRoute · ${c.entry.routeName} · ${model.id}`,
      maxInputTokens: Math.max(contextLength - maxOutputTokens, 1024),
      maxOutputTokens,
      capabilities: {
        toolCalling: caps.tool_calling !== false,
        imageInput: caps.vision === true,
      },
      omniModelId: c.entry.modelId,
      routeId: c.entry.routeId,
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
      void vscode.commands.executeCommand("omnicopilot.manage");
    } else if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
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
      tools: this.capTools(options.tools, log),
    };
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      request.tool_choice = "required";
    }
    const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
    if (typeof modelOptions?.temperature === "number") {
      request.temperature = modelOptions.temperature;
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
    const routes = await cachedLoadRoutes(this.deps.context);
    const firstByteTimeoutMs =
      getConfig().get<number>("firstByteTimeoutSeconds", 120) * 1000;
    const clientByRoute = new Map(
      routes.map((r) => [r.id, getClientForRoute(r, this.deps.log, firstByteTimeoutMs)])
    );
    const nameByRoute = new Map(routes.map((r) => [r.id, r.name]));

    const primaryEntry = this.cachedModels.find((c) => c.entry.prefixedId === model.id)?.entry;
    if (!primaryEntry) {
      this.deps.log.error(
        `Primary model not found in catalog: ${model.id}. Available: ${this.cachedModels.map((c) => c.entry.prefixedId).join(", ")}`
      );
    }
    const fallbacks = primaryEntry
      ? pickFallbackCandidates(
          primaryEntry,
          this.cachedModels,
          Boolean(options.tools?.length),
          getConfig().get<FallbackMode>("fallbackMode", "sameModel")
        )
      : [];
    // The prefixedId is the source of truth for what the user selected.
    // Resolve the route from the catalog entry, NOT from model.routeId which
    // can be stale or point to a different server.
    if (!primaryEntry && (!model.routeId || !model.omniModelId)) {
      throw new OmniRouteError(`Model ${model.id} is not available or not properly configured`, undefined);
    }
    const primary: FallbackCandidate = primaryEntry
      ? { routeId: primaryEntry.routeId, modelId: primaryEntry.modelId }
      : { routeId: model.routeId!, modelId: model.omniModelId! };

    log.info(
      `Selected model: ${primary.modelId} on route ${primary.routeId} (prefixedId: ${model.id}, cachedModels: ${this.cachedModels.map((c) => c.entry.prefixedId).join(", ")})`
    );

    // Filter out offline servers from fallbacks so an unreachable secondary
    // server never blocks or delays requests on a healthy primary server.
    const knownOnline = this.deps.getOnlineRouteIds?.() ?? new Set<string>();
    const fallbacksByHealth =
      knownOnline.size > 0
        ? fallbacks.filter((f) => knownOnline.has(f.routeId))
        : fallbacks;

    const candidates = [primary, ...fallbacksByHealth];
    const serverCount = new Set(candidates.map((c) => c.routeId)).size;

    // Pre-compute the fallback chain readout: building it inline would nest a
    // template literal inside another one (Sonar S4624).
    const fallbackSummary = fallbacksByHealth.map((f) => `${f.routeId}:${f.modelId}`).join(", ");
    log.info(
      `Chat → ${primary.modelId} @${primary.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbackSummary}` : "")
    );

    const retriesPerServer = getConfig().get<number>("retriesPerServer", 3);
    return {
      clientByRoute,
      nameByRoute,
      candidates,
      serverCount,
      modelId: model.omniModelId,
      retriesPerServer,
      admissionRetries: Math.max(retriesPerServer, 12),
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
    const candidates = plan.candidates;
    const lastIndex = candidates.length - 1;
    let lastError: unknown;

    for (const [i, cand] of candidates.entries()) {
      if (this.isCandidateCoolingDown(cand.routeId, i, lastIndex)) {
        this.deps.log.warn(`Skipping ${cand.routeId}: circuit breaker cooldown active`);
        continue;
      }
      if (token.isCancellationRequested) {
        this.deps.onRequestEnd?.(false, undefined, i);
        return;
      }
      const client = plan.clientByRoute.get(cand.routeId);
      if (!client) {
        lastError = new OmniRouteError(`Route ${cand.routeId} is not configured`, undefined);
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
        admissionRetries: plan.admissionRetries,
      });
      if (outcome.kind === "succeeded") return;
      if (outcome.kind === "cancelled") return;
      lastError = outcome.error;
      if (i === lastIndex) {
        this.reportChatFailure({
          routeId: cand.routeId,
          fallbacksUsed: i,
          err: outcome.error,
          modelId: plan.modelId,
          serverCount: plan.serverCount,
          candidateCount: candidates.length,
        });
      }
    }
    if (lastError !== undefined) {
      this.reportChatFailure({
        routeId: candidates[0]?.routeId,
        fallbacksUsed: candidates.length - 1,
        err: lastError,
        modelId: plan.modelId,
        serverCount: plan.serverCount,
        candidateCount: candidates.length,
      });
    }
    throw new OmniRouteError("No configured route served this model", undefined);
  }

  /** True while a route's circuit breaker is cooling down and it isn't the
   * last resort — the last candidate is never skipped. */
  private isCandidateCoolingDown(routeId: string, i: number, lastIndex: number): boolean {
    return this.isRouteCoolingDown(routeId) && i < lastIndex;
  }

  /** Retries one candidate until it succeeds, cancels, stalls, or exhausts
   * its attempts. Fatal errors (mid-stream or non-transient) propagate. */
  private async tryCandidate(ctx: ChatCandidateContext): Promise<CandidateOutcome> {
    const { cand, i, token, log, retriesPerServer, admissionRetries } = ctx;
    let attempted = 0;
    let candError: unknown;
    // Start with the configured limit; upgraded to admissionRetries if we
    // see 503/429 (the upstream is healthy, just temporarily full).
    let effectiveRetries = retriesPerServer;

    for (; attempted < effectiveRetries; attempted++) {
      if (token.isCancellationRequested) {
        this.deps.onRequestEnd?.(false, undefined, i);
        return { kind: "cancelled" };
      }
      const attempt = await this.streamAttempt(ctx);
      if (attempt.kind === "completed") {
        this.reportUsage(cand, attempt, ctx);
        this.recordRouteSuccess(cand.routeId);
        this.deps.onActivity?.(true, cand.routeId);
        this.deps.onRequestEnd?.(true, undefined, i);
        return { kind: "succeeded" };
      }
      if (attempt.kind === "cancelled") return { kind: "cancelled" };
      candError = attempt.error;
      log.warn(
        `Model ${cand.modelId} @${cand.routeId} attempt ${attempted + 1}/${effectiveRetries} failed (${formatErrorValue(candError)})`
      );
      // A stall means the upstream is alive and already processing the same
      // request; re-sending it would burn tokens a second time. Move to the
      // next candidate instead.
      if (attempt.stall) {
        this.deps.onStall?.(cand.routeId);
        break;
      }
      // 503/429/concurrency/saturation = upstream is healthy but temporarily
      // full. Escalate to more retries with longer backoff — this usually
      // resolves in a few seconds, just like direct JSON / Copilot does.
      if (attempt.throttle) {
        effectiveRetries = Math.max(effectiveRetries, admissionRetries);
      }
      if (attempted + 1 < effectiveRetries) {
        await delay(computeBackoffMs(attempt.error, attempt.throttle, attempted), token);
        continue;
      }
    }

    this.recordCandFailure(cand.routeId, candError);
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
    this.deps.onUsage?.({
      routeId: cand.routeId,
      baseUrl: ctx.client?.baseUrl ?? "",
      serverName: ctx.routeName,
      modelName: cand.modelId,
      inputTokens: ctx.inputTokens,
      outputTokens: estimateTokens(attempt.streamed),
    });
  }

  /** One stream attempt: consumes events, reports parts, and classifies the
   * outcome. Cancellation is honored at every checkpoint. */
  private async streamAttempt(ctx: ChatCandidateContext): Promise<StreamAttemptOutcome> {
    const { cand, i, client, request, progress, token, abort, log } = ctx;
    let streamed = "";
    let reportedAny = false;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    this.deps.onRequestStart?.(cand.routeId, cand.modelId);
    try {
      const consumed = await this.consumeStream(
        client,
        { ...request, model: cand.modelId },
        abort,
        progress,
        token
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
        this.deps.onRequestEnd?.(false, undefined, i);
        return { kind: "cancelled" };
      }
      const finishedAt = Date.now();
      log.info(
        `Chat ✓ ${cand.modelId} @${cand.routeId} (TTFT: ${firstTokenAt ? firstTokenAt - startedAt : "n/a"}ms, total: ${finishedAt - startedAt}ms, output: ${estimateTokens(streamed)} tokens)`
      );
      return { kind: "completed", streamed, startedAt, firstTokenAt };
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
    token: vscode.CancellationToken
  ): Promise<{ streamed: string; reportedAny: boolean; firstTokenAt: number | undefined }> {
    let streamed = "";
    let reportedAny = false;
    let firstTokenAt: number | undefined;
    for await (const event of client.streamChat(request, abort.signal)) {
      if (token.isCancellationRequested) break;
      if (event.kind === "text") {
        firstTokenAt ??= Date.now();
        streamed += event.text;
        reportedAny = true;
        progress.report(new vscode.LanguageModelTextPart(event.text));
      } else {
        reportedAny = true;
        progress.report(
          new vscode.LanguageModelToolCallPart(event.id, event.name, parseToolCallArgs(event, this.deps.log))
        );
      }
    }
    return { streamed, reportedAny, firstTokenAt };
  }

  /** Classifies a failed attempt: cancellation, mid-stream/fatal → throw,
   * anything transient → retryable with stall/throttle flags. */
  private concludeStreamFailure(
    err: unknown,
    reportedAny: boolean,
    ctx: ChatCandidateContext
  ): StreamAttemptOutcome {
    const { cand, i, token, log } = ctx;
    if (token.isCancellationRequested) {
      this.deps.onRequestEnd?.(false, undefined, i);
      return { kind: "cancelled" };
    }
    if (reportedAny) {
      this.deps.onActivity?.(false, cand.routeId);
      log.error(`Chat request failed mid-stream: ${formatErrorValue(err)}`);
      this.deps.onRequestEnd?.(false, describeFetchError(err), i);
      throw err;
    }
    const status = errorStatus(err);
    // Network-level failures (no HTTP status, e.g. `fetch failed`) are
    // treated as transient so the server can be re-attempted.
    const transient = status === undefined || isTransientHttpError(status);
    if (!transient) {
      this.deps.onActivity?.(false, cand.routeId);
      log.error(`Chat request failed: ${formatErrorValue(err)}`);
      this.deps.onRequestEnd?.(false, describeFetchError(err), i);
      throw err;
    }
    return {
      kind: "failed",
      error: err,
      stall: err instanceof OmniRouteError && err.stall,
      throttle: status === 503 || status === 429 || isThrottleError(err),
    };
  }

  /** Records a circuit-breaker failure — except 503/429/saturation, which are
   * upstream throttling, not route failures. */
  private recordCandFailure(routeId: string, err: unknown): void {
    const status = errorStatus(err);
    if (status !== 503 && status !== 429 && !isThrottleError(err)) {
      this.recordRouteFailure(routeId);
    }
  }

  /** Surfaces the final failure: status bar, error message, and throw. */
  private reportChatFailure(args: {
    routeId: string | undefined;
    fallbacksUsed: number;
    err: unknown;
    modelId: string;
    serverCount: number;
    candidateCount: number;
  }): never {
    const { routeId, fallbacksUsed, err, modelId, serverCount, candidateCount } = args;
    this.deps.onActivity?.(false, routeId);
    this.deps.log.error(`Chat request failed after ${candidateCount} model(s): ${formatErrorValue(err)}`);
    this.deps.onRequestEnd?.(false, describeFetchError(err), fallbacksUsed);
    void vscode.window.showErrorMessage(describeFinalFailure(modelId, serverCount, err));
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
