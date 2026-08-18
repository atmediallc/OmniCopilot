import * as vscode from "vscode";
import { EncryptedReasoningFilter, OmniRouteError, describeFetchError, isTransientHttpError, isThrottleError } from "./client";

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

/** Small non-abortable pause between fallback attempts to avoid hammering a
 * busy server. Kept short; cancellation is re-checked on the next iteration. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    for (const key of Array.from(OmniRouteChatProvider.sharedRouteCatalogs.keys())) {
      if (!validRouteIds.has(key)) {
        OmniRouteChatProvider.sharedRouteCatalogs.delete(key);
      }
    }

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
              this.deps.log.warn(`Route "${r.name}" (${r.baseUrl}) model discovery failed: ${String(err)}`);
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
    const filterRaw = cfg.get<string>("modelFilter", "").trim();

    let filter: RegExp | undefined;
    if (filterRaw) {
      try {
        if (filterRaw.length > 200) {
          throw new Error("Filter too long");
        }
        filter = new RegExp(filterRaw, "i");
      } catch {
        // invalid or overly complex regex → fall back to safe escaped substring matching
        const needle = filterRaw.slice(0, 200).toLowerCase();
        filter = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    }

    const infos: OmniModelInfo[] = [];
    for (const c of catalog) {
      if (validRouteIds && !validRouteIds.has(c.entry.routeId)) {
        continue;
      }
      if (this.filterRouteId && c.entry.routeId !== this.filterRouteId) {
        continue;
      }
      const model = c.model;
      if (!model?.id) continue;

      if (filter && !filter.test(model.id)) continue;

      const contextLength = model.context_length ?? defaultContext;
      const maxOutputTokens = Math.min(model.max_completion_tokens ?? maxOutput, maxOutput);
      const caps = model.capabilities ?? {};
      const isCombo = model.owned_by === "combo";

      const displayName = model.display_name?.trim() || model.id;
      const name = `${displayName} (${c.entry.routeName})`;

      infos.push({
        id: c.entry.prefixedId,
        name,
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
      });
    }
    return infos;
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

    const request: ChatRequest = {
      model: model.omniModelId,
      messages: toOpenAiMessages(messages),
      stream: true,
      tools: (() => {
        const allTools = toOpenAiTools(options.tools);
        if (!allTools?.length) return allTools;
        // maxTools <= 0 means "send every tool VS Code provides". A positive
        // value is an explicit hard cap for saving context.
        const maxTools = getConfig().get<number>("maxTools", 0);
        if (maxTools > 0 && allTools.length <= maxTools) return allTools;
        if (maxTools > 0) {
          log.warn(`Limiting tools from ${allTools.length} to ${maxTools}`);
          return allTools.slice(0, maxTools);
        }
        return allTools;
      })(),
    };

    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      request.tool_choice = "required";
    }

    const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
    if (typeof modelOptions?.temperature === "number") {
      request.temperature = modelOptions.temperature;
    }

    // Route per candidate; a route disappearing mid-session is skipped, never
    // fatal. Fallback chain (transient 429/5xx only): primary → same model on
    // another route → same family on the same route → any compatible model.
    const routes = await cachedLoadRoutes(this.deps.context);
    const firstByteTimeoutMs =
      getConfig().get<number>("firstByteTimeoutSeconds", 120) * 1000;
    const clientByRoute = new Map(
      routes.map((r) => [r.id, getClientForRoute(r, this.deps.log, firstByteTimeoutMs)])
    );

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
          getConfig().get<FallbackMode>("fallbackMode", "none")
        )
      : [];
    if (!primaryEntry && (!model.routeId || !model.omniModelId)) {
      throw new OmniRouteError(`Model ${model.id} is not available or not properly configured`, undefined);
    }
    // The prefixedId is the source of truth for what the user selected.
    // Resolve the route from the catalog entry, NOT from model.routeId which
    // can be stale or point to a different server.
    const primary: FallbackCandidate = primaryEntry
      ? { routeId: primaryEntry.routeId, modelId: primaryEntry.modelId }
      : { routeId: model.routeId!, modelId: model.omniModelId! };

    this.deps.log.info(
      `Selected model: ${primary.modelId} on route ${primary.routeId} (prefixedId: ${model.id}, cachedModels: ${this.cachedModels.map(c => c.entry.prefixedId).join(", ")})`
    );

    // Filter out offline servers from fallbacks so an unreachable secondary server
    // never blocks or delays requests on a healthy primary server.
    const knownOnline = this.deps.getOnlineRouteIds?.() ?? new Set<string>();
    const fallbacksByHealth =
      knownOnline.size > 0
        ? fallbacks.filter((f) => knownOnline.has(f.routeId))
        : fallbacks;

    const candidates = [primary, ...fallbacksByHealth];
    const serverCount = new Set(candidates.map((c) => c.routeId)).size;
    const lastIndex = candidates.length - 1;

    log.info(
      `Chat → ${primary.modelId} @${primary.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbacksByHealth.map((f) => `${f.routeId}:${f.modelId}`).join(", ")}` : "")
    );

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    // Estimate the input side of the request for the usage readout.
    const inputTokens = messages.reduce((n, msg) => n + estimateTokens(msg), 0);

    let lastError: unknown;

    try {
      // Single chat retry layer: route clients make one HTTP attempt, then
      // this loop can immediately move to another server. Defaults to 3
      // attempts so transient 503 ("capacity busy") / 429 get a bounded,
      // backoff-driven retry on the same server before giving up.
      const retriesPerServer = getConfig().get<number>("retriesPerServer", 3);
      // 503/429 are upstream throttling — give them up to 12 retries with jittered
      // backoff so capacity blips resolve transparently without failing.
      const admissionRetries = Math.max(retriesPerServer, 12);

      for (const [i, cand] of candidates.entries()) {
        if (this.isRouteCoolingDown(cand.routeId) && i < lastIndex) {
          log.warn(`Skipping ${cand.routeId}: circuit breaker cooldown active`);
          continue;
        }
        const client = clientByRoute.get(cand.routeId);
        if (token.isCancellationRequested) {
          this.deps.onRequestEnd?.(false, undefined, i);
          return;
        }
        if (!client) {
          lastError = new OmniRouteError(`Route ${cand.routeId} is not configured`, undefined);
          continue;
        }
        const last = i === lastIndex;
        const attemptRequest = { ...request, model: cand.modelId };
        const routeName = routes.find((r) => r.id === cand.routeId)?.name ?? cand.routeId;
        let attempted = 0;
        let candError: unknown;
        // Start with the configured limit; upgraded to admissionRetries if we
        // see 503/429 (the upstream is healthy, just temporarily full).
        let effectiveRetries = retriesPerServer;
        for (; attempted < effectiveRetries; attempted++) {
          if (token.isCancellationRequested) {
            this.deps.onRequestEnd?.(false, undefined, i);
            return;
          }
          let streamed = "";
          let reportedAny = false;
          const startedAt = Date.now();
          let firstTokenAt: number | undefined;
          this.deps.onRequestStart?.(cand.routeId, cand.modelId);
          const reasoningFilter = new EncryptedReasoningFilter();
          try {
            for await (const event of client.streamChat(attemptRequest, abort.signal)) {
              if (token.isCancellationRequested) break;
              if (event.kind === "text") {
                for (const safeText of reasoningFilter.push(event.text)) {
                  firstTokenAt ??= Date.now();
                  streamed += safeText;
                  reportedAny = true;
                  progress.report(new vscode.LanguageModelTextPart(safeText));
                }
              } else {
                for (const safeText of reasoningFilter.flush()) {
                  firstTokenAt ??= Date.now();
                  streamed += safeText;
                  reportedAny = true;
                  progress.report(new vscode.LanguageModelTextPart(safeText));
                }
                reportedAny = true;
                let input: Record<string, unknown>;
                try {
                  const parsed = JSON.parse(event.args);
                  input = parsed && typeof parsed === "object" && !Array.isArray(parsed)
                    ? (parsed as Record<string, unknown>)
                    : {};
                } catch {
                  log.warn(`Tool call ${event.name} had invalid JSON args; sending {}`);
                  input = {};
                }
                progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, input));
              }
            }
            for (const safeText of reasoningFilter.flush()) {
              firstTokenAt ??= Date.now();
              streamed += safeText;
              reportedAny = true;
              progress.report(new vscode.LanguageModelTextPart(safeText));
            }
            if (!reportedAny) {
              log.warn(`Model ${cand.modelId} @${cand.routeId} returned an empty stream; emitting empty text part`);
              progress.report(new vscode.LanguageModelTextPart(""));
              reportedAny = true;
            }
            // User cancelled after the first tokens: the request did not
            // complete — don't count it as success or bill usage.
            if (token.isCancellationRequested) {
              this.deps.onRequestEnd?.(false, undefined, i);
              return;
            }
            const finishedAt = Date.now();
            log.info(
              `Chat ✓ ${cand.modelId} @${cand.routeId} (TTFT: ${firstTokenAt ? firstTokenAt - startedAt : "n/a"}ms, total: ${finishedAt - startedAt}ms, output: ${estimateTokens(streamed)} tokens)`
            );
            this.deps.onUsage?.({
              routeId: cand.routeId,
              baseUrl: client?.baseUrl ?? "",
              serverName: routeName,
              modelName: cand.modelId,
              inputTokens,
              outputTokens: estimateTokens(streamed),
            });
            this.recordRouteSuccess(cand.routeId);
            this.deps.onActivity?.(true, cand.routeId);
            this.deps.onRequestEnd?.(true, undefined, i);
            return;
          } catch (err) {
            if (token.isCancellationRequested) {
              this.deps.onRequestEnd?.(false, undefined, i);
              return;
            }
            if (reportedAny) {
              this.deps.onActivity?.(false, cand.routeId);
              log.error(`Chat request failed mid-stream: ${String(err)}`);
              this.deps.onRequestEnd?.(false, describeFetchError(err), i);
              throw err;
            }
            const status = err instanceof OmniRouteError ? err.status : undefined;
            // Network-level failures (no HTTP status, e.g. `fetch failed`) are
            // treated as transient so the server can be re-attempted.
            const transient = status === undefined || isTransientHttpError(status);
            if (!transient) {
              this.deps.onActivity?.(false, cand.routeId);
              log.error(`Chat request failed: ${String(err)}`);
              this.deps.onRequestEnd?.(false, describeFetchError(err), i);
              throw err;
            }
            candError = err;
            log.warn(
              `Model ${cand.modelId} @${cand.routeId} attempt ${attempted + 1}/${effectiveRetries} failed (${String(err)})`
            );
            // A stall means the upstream is alive and already processing the
            // same request; re-sending it would burn tokens a second time.
            // Skip remaining attempts on this server and move to the next
            // candidate instead.
            if (err instanceof OmniRouteError && err.stall) {
              this.deps.onStall?.(cand.routeId);
              break;
            }
            // 503/429/concurrency/saturation = upstream is healthy but temporarily full. Upgrade to
            // more retries with longer backoff — this usually resolves in a
            // few seconds, just like direct JSON / Copilot does.
            const isThrottle = status === 503 || status === 429 || isThrottleError(err);
            if (isThrottle) {
              effectiveRetries = Math.max(effectiveRetries, admissionRetries);
            }
            if (attempted + 1 < effectiveRetries) {
              const baseDelay = isThrottle ? 1500 + Math.random() * 1000 : 250;
              const maxDelay = isThrottle ? 8000 : 2000;
              const multiplier = isThrottle ? 1.5 : 2;
              await delay(Math.min(maxDelay, baseDelay * Math.pow(multiplier, attempted)));
              continue;
            }
          }
        }

        lastError = candError;
        // 503 (admission capacity) and 429 (rate limit) / saturation errors are upstream throttling,
        // not route failures — don't penalize the route's circuit breaker.
        const lastStatus = candError instanceof OmniRouteError ? candError.status : undefined;
        if (lastStatus !== 503 && lastStatus !== 429 && !isThrottleError(candError)) {
          this.recordRouteFailure(cand.routeId);
        }
        log.warn(
          `Server ${cand.routeId} gave up after ${attempted} attempt(s) (${String(candError)}); next server`
        );
        if (last) {
          this.deps.onActivity?.(false, cand.routeId);
          const reason = candError instanceof OmniRouteError ? candError.message : String(candError);
          log.error(`Chat request failed after ${candidates.length} model(s): ${reason}`);
          this.deps.onRequestEnd?.(false, describeFetchError(candError), i);
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              "OmniRoute: the model {0} couldn't be reached on any of {1} server(s). Last error: {2}. Check the server's proxy/API key in the panel or pick another model.",
              model.omniModelId,
              String(serverCount),
              reason
            )
          );
          throw candError;
        }
      }
      if (lastError !== undefined) {
        const reason = lastError instanceof OmniRouteError ? lastError.message : String(lastError);
        this.deps.onActivity?.(false, candidates[0]?.routeId);
        log.error(`Chat request failed after ${candidates.length} model(s): ${reason}`);
        this.deps.onRequestEnd?.(false, describeFetchError(lastError), candidates.length - 1);
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            "OmniRoute: the model {0} couldn't be reached on any of {1} server(s). Last error: {2}. Check the server's proxy/API key in the panel or pick another model.",
            model.omniModelId,
            String(serverCount),
            reason
          )
        );
        throw lastError;
      }
      throw new OmniRouteError("No configured route served this model", undefined);
    } finally {
      cancelSub.dispose();
    }
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
