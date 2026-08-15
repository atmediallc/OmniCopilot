import * as vscode from "vscode";
import { OmniRouteError, isTransientHttpError } from "./client";
import { estimateTokens, toOpenAiMessages, toOpenAiTools } from "./convert";
import { buildCatalog, loadRoutes, makeClientForRoute, pickFallbackCandidates } from "./routes";
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
  /** routeIds that passed the most recent liveness probe; chat deprioritizes
   * the rest so unreachable servers aren't tried first. */
  getOnlineRouteIds?: () => ReadonlySet<string> | undefined;
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

  private static sharedCachedModels: CatalogModel[] = [];
  private static sharedLastCatalogFetch = 0;
  private static sharedFetchPromise: Promise<CatalogModel[]> | null = null;
  private static readonly CACHE_STATE_KEY = "omnicopilot.cachedCatalog.v1";
  private static readonly CACHE_TIME_KEY = "omnicopilot.cachedCatalogTime.v1";

  static loadPersistentCache(context: vscode.ExtensionContext): void {
    const savedCatalog = context.globalState.get<CatalogModel[]>(OmniRouteChatProvider.CACHE_STATE_KEY);
    const savedTime = context.globalState.get<number>(OmniRouteChatProvider.CACHE_TIME_KEY);
    if (Array.isArray(savedCatalog) && savedCatalog.length > 0 && typeof savedTime === "number" && savedTime > 0) {
      OmniRouteChatProvider.sharedCachedModels = savedCatalog;
      OmniRouteChatProvider.sharedLastCatalogFetch = savedTime;
    }
  }

  private static async persistCache(context: vscode.ExtensionContext, catalog: CatalogModel[]): Promise<void> {
    if (catalog.length > 0) {
      await context.globalState.update(OmniRouteChatProvider.CACHE_STATE_KEY, catalog);
      await context.globalState.update(OmniRouteChatProvider.CACHE_TIME_KEY, Date.now());
    }
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
    OmniRouteChatProvider.sharedCachedModels = [];
    OmniRouteChatProvider.sharedLastCatalogFetch = 0;
    await this.deps.context.globalState.update(OmniRouteChatProvider.CACHE_TIME_KEY, 0);
    this._onDidChange.fire();
  }

  // ── Model discovery ─────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const routes = await loadRoutes(this.deps.context);
    if (routes.length === 0) return [];

    const ttlMinutes = getConfig().get<number>("modelCacheTtlMinutes", 15);
    const isManualOnly = ttlMinutes <= 0;
    const ttlMs = isManualOnly ? Number.POSITIVE_INFINITY : ttlMinutes * 60_000;
    const isFresh = Date.now() - OmniRouteChatProvider.sharedLastCatalogFetch < ttlMs;

    if (OmniRouteChatProvider.sharedCachedModels.length > 0 && isFresh) {
      return this.toModelInfos(OmniRouteChatProvider.sharedCachedModels);
    }

    if (!OmniRouteChatProvider.sharedFetchPromise) {
      OmniRouteChatProvider.sharedFetchPromise = (async () => {
        let allSucceeded = true;
        const segments: RouteCatalog[] = await Promise.all(
          routes.map(async (r) => {
            try {
              const models = await makeClientForRoute(r, this.deps.log).listModels();
              this.deps.onActivity?.(true, r.id);
              this.deps.log.info(`Route "${r.name}" (${r.baseUrl}) model discovery succeeded: ${models.length} model(s)`);
              return { routeId: r.id, name: r.name, models };
            } catch (err) {
              allSucceeded = false;
              this.deps.onActivity?.(false, r.id);
              this.deps.log.warn(`Route "${r.name}" (${r.baseUrl}) model discovery failed: ${String(err)}`);
              return { routeId: r.id, name: r.name, models: [] };
            }
          })
        );

        const catalog = buildCatalog(segments);
        if (catalog.length > 0) {
          OmniRouteChatProvider.sharedCachedModels = catalog;
          if (allSucceeded) {
            OmniRouteChatProvider.sharedLastCatalogFetch = Date.now();
            void OmniRouteChatProvider.persistCache(this.deps.context, catalog);
          } else {
            OmniRouteChatProvider.sharedLastCatalogFetch = 0;
            this.deps.log.warn("Not all configured servers responded successfully during model discovery. Cache TTL will not be set so missing servers will be retried.");
          }
        }
        return catalog;
      })().finally(() => {
        OmniRouteChatProvider.sharedFetchPromise = null;
      });
    }

    const catalog = await OmniRouteChatProvider.sharedFetchPromise;
    const anyModel = catalog.length > 0;
    if (!anyModel) {
      // No route answered with a model list. Only prompt when the caller
      // wants it (model picker opened by the user); otherwise contribute none.
      if (!options.silent) void this.offerConnectionHelp();
      return [];
    }

    const infos = this.toModelInfos(catalog);
    this.deps.log.info(
      `Listed ${infos.length} models for vendor (filterRouteId: ${this.filterRouteId ?? "all"}, total cached: ${catalog.length})`
    );
    return infos;
  }

  private toModelInfos(catalog: CatalogModel[]): OmniModelInfo[] {
    const cfg = getConfig();
    const maxOutput = cfg.get<number>("maxOutputTokens", 16384);
    const defaultContext = cfg.get<number>("defaultContextLength", 128000);
    const filterRaw = cfg.get<string>("modelFilter", "").trim();

    let filter: RegExp | undefined;
    if (filterRaw) {
      try {
        filter = new RegExp(filterRaw, "i");
      } catch {
        // invalid regex → fall back to substring matching
        const needle = filterRaw.toLowerCase();
        filter = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    }

    const infos: OmniModelInfo[] = [];
    for (const c of catalog) {
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
    const routes = await loadRoutes(this.deps.context);
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
        const maxTools = getConfig().get<number>("maxTools", 32);
        if (allTools.length <= maxTools) return allTools;
        log.warn(`Limiting tools from ${allTools.length} to ${maxTools}`);
        return allTools.slice(0, maxTools);
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
    const routes = await loadRoutes(this.deps.context);
    const firstByteTimeoutMs =
      getConfig().get<number>("firstByteTimeoutSeconds", 120) * 1000;
    const clientByRoute = new Map(
      routes.map((r) => [r.id, makeClientForRoute(r, this.deps.log, firstByteTimeoutMs)])
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
          getConfig().get<FallbackMode>("fallbackMode", "sameModel")
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

    // Reorder fallbacks to prioritize online servers, but keep primary first.
    const knownOnline = this.deps.getOnlineRouteIds?.() ?? new Set<string>();
    const fallbacksByHealth =
      knownOnline.size > 0
        ? [...fallbacks].sort(
            (a, b) =>
              (knownOnline.has(a.routeId) ? 0 : 1) - (knownOnline.has(b.routeId) ? 0 : 1)
          )
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
      // this loop can immediately move to another server.
      const retriesPerServer = getConfig().get<number>("retriesPerServer", 1);

      for (const [i, cand] of candidates.entries()) {
        const client = clientByRoute.get(cand.routeId);
        if (token.isCancellationRequested) return;
        if (!client) {
          lastError = new OmniRouteError(`Route ${cand.routeId} is not configured`, undefined);
          continue;
        }
        const last = i === lastIndex;
        const attemptRequest = { ...request, model: cand.modelId };
        const routeName = routes.find((r) => r.id === cand.routeId)?.name ?? cand.routeId;
        let attempted = 0;
        let candError: unknown;
        for (; attempted < retriesPerServer; attempted++) {
          if (token.isCancellationRequested) return;
          let streamed = "";
          let reportedAny = false;
          try {
            for await (const event of client.streamChat(attemptRequest, abort.signal)) {
              if (token.isCancellationRequested) break;
              if (event.kind === "text") {
                streamed += event.text;
                reportedAny = true;
                progress.report(new vscode.LanguageModelTextPart(event.text));
              } else {
                reportedAny = true;
                let input: Record<string, unknown>;
                try {
                  input = JSON.parse(event.args) as Record<string, unknown>;
                } catch {
                  log.warn(`Tool call ${event.name} had invalid JSON args; sending {}`);
                  input = {};
                }
                progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, input));
              }
            }
            this.deps.onUsage?.({
              routeId: cand.routeId,
              baseUrl: client?.baseUrl ?? "",
              serverName: routeName,
              modelName: cand.modelId,
              inputTokens,
              outputTokens: estimateTokens(streamed),
            });
            this.deps.onActivity?.(true, cand.routeId);
            return;
          } catch (err) {
            if (token.isCancellationRequested) return;
            if (reportedAny) {
              this.deps.onActivity?.(false, cand.routeId);
              log.error(`Chat request failed mid-stream: ${String(err)}`);
              throw err;
            }
            const status = err instanceof OmniRouteError ? err.status : undefined;
            // Network-level failures (no HTTP status, e.g. `fetch failed`) are
            // treated as transient so the server can be re-attempted.
            const transient = status === undefined || isTransientHttpError(status);
            if (!transient) {
              this.deps.onActivity?.(false, cand.routeId);
              log.error(`Chat request failed: ${String(err)}`);
              throw err;
            }
            candError = err;
            log.warn(
              `Model ${cand.modelId} @${cand.routeId} attempt ${attempted + 1}/${retriesPerServer} failed (${String(err)})`
            );
            // A stall means the upstream is alive and already processing the
            // same request; re-sending it would burn tokens a second time.
            // Skip remaining attempts on this server and move to the next
            // candidate instead.
            if (err instanceof OmniRouteError && err.stall) break;
            if (attempted + 1 < retriesPerServer) {
              await delay(Math.min(2000, 250 * Math.pow(2, attempted)));
              continue;
            }
          }
        }

        lastError = candError;
        log.warn(
          `Server ${cand.routeId} gave up after ${attempted} attempt(s) (${String(candError)}); next server`
        );
        if (last) {
          this.deps.onActivity?.(false, cand.routeId);
          const reason = candError instanceof OmniRouteError ? candError.message : String(candError);
          log.error(`Chat request failed after ${candidates.length} model(s): ${reason}`);
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
