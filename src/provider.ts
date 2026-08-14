import * as vscode from "vscode";
import { OmniRouteError, isTransientHttpError } from "./client";
import { estimateTokens, toOpenAiMessages, toOpenAiTools } from "./convert";
import { buildCatalog, loadRoutes, makeClientForRoute, pickFallbackCandidates } from "./routes";
import type { ChatRequest } from "./types";
import type { CatalogModel, RouteCatalog } from "./routes";

interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
  routeId: string;
}

export interface ProviderDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  /** Called whenever a request round-trip settles, with success flag —
   * feeds the status bar without extra polling. */
  onActivity?: (ok: boolean) => void;
  /** Live token usage while a chat response streams — feeds the status bar. */
  onUsage?: (usage: { serverName: string; modelName: string; inputTokens: number; outputTokens: number }) => void;
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

  private cachedModels: CatalogModel[] = [];

  constructor(private readonly deps: ProviderDeps) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** Re-query the catalog and tell VS Code the model list changed. */
  async refresh(): Promise<void> {
    this.cachedModels = [];
    this._onDidChange.fire();
  }

    // ── Model discovery ─────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const routes = await loadRoutes(this.deps.context);
    if (routes.length === 0) return [];

    const segments: RouteCatalog[] = await Promise.all(
      routes.map(async (r) => {
        try {
          const models = await makeClientForRoute(r).listModels(token);
          this.deps.onActivity?.(true);
          return { routeId: r.id, name: r.name, models };
        } catch (err) {
          this.deps.onActivity?.(false);
          this.deps.log.warn(`Route "${r.name}" model discovery failed: ${String(err)}`);
          return { routeId: r.id, name: r.name, models: [] };
        }
      })
    );

    const anyModel = segments.some((s) => s.models.length > 0);
    if (!anyModel) {
      // No route answered with a model list. Only prompt when the caller
      // wants it (model picker opened by the user); otherwise contribute none.
      if (!options.silent) void this.offerConnectionHelp();
      return [];
    }

    const catalog = buildCatalog(segments);
    this.cachedModels = catalog;
    const infos = this.toModelInfos(catalog);
    // `this.cachedModels` is read here so Task 3 compiles clean before the
    // chat fallback (Task 4) starts consuming it.
    this.deps.log.info(
      `Listed ${infos.length} models from ${segments.map((s) => `${s.name}(${s.models.length})`).join(", ")} (cached ${this.cachedModels.length})`
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
      const model = c.model;
      if (!model?.id) continue;
      if (filter && !filter.test(model.id)) continue;

      const contextLength = model.context_length ?? defaultContext;
      const maxOutputTokens = Math.min(model.max_completion_tokens ?? maxOutput, maxOutput);
      const caps = model.capabilities ?? {};
      const isCombo = model.owned_by === "combo";

      infos.push({
        id: c.entry.prefixedId,
        name: `${c.entry.routeName} · ${model.display_name?.trim() || model.id}`,
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
      tools: toOpenAiTools(options.tools),
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
    const clientByRoute = new Map(routes.map((r) => [r.id, makeClientForRoute(r)]));

    const primaryEntry = this.cachedModels.find((c) => c.entry.prefixedId === model.id)?.entry;
    const fallbacks = primaryEntry
      ? pickFallbackCandidates(primaryEntry, this.cachedModels, Boolean(options.tools?.length))
      : [];
    const candidates = [{ routeId: model.routeId, modelId: model.omniModelId }, ...fallbacks];
    const serverCount = new Set(candidates.map((c) => c.routeId)).size;
    const lastIndex = candidates.length - 1;

    log.debug(
      `Chat → ${model.omniModelId} @${model.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbacks.map((f) => `${f.routeId}:${f.modelId}`).join(", ")}` : "")
    );

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    // Estimate the input side of the request for the usage readout.
    const inputTokens = messages.reduce((n, msg) => n + estimateTokens(msg), 0);

    try {
      for (const [i, cand] of candidates.entries()) {
        const client = clientByRoute.get(cand.routeId);
        if (token.isCancellationRequested) return;
        if (!client) continue;
        const last = i === lastIndex;
        const attemptRequest = cand.modelId === model.omniModelId ? request : { ...request, model: cand.modelId };
        const routeName = routes.find((r) => r.id === cand.routeId)?.name ?? cand.routeId;
        let streamed = "";

        try {
          for await (const event of client.streamChat(attemptRequest, abort.signal)) {
            if (token.isCancellationRequested) break;
            if (event.kind === "text") {
              streamed += event.text;
              progress.report(new vscode.LanguageModelTextPart(event.text));
              this.deps.onUsage?.({
                serverName: routeName,
                modelName: cand.modelId,
                inputTokens,
                outputTokens: estimateTokens(streamed),
              });
            } else {
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
          this.deps.onActivity?.(true);
          return;
        } catch (err) {
          if (token.isCancellationRequested) return;
          const status = err instanceof OmniRouteError ? err.status : undefined;
          const transient = status !== undefined && isTransientHttpError(status);
          if (!transient) {
            this.deps.onActivity?.(false);
            log.error(`Chat request failed: ${String(err)}`);
            throw err;
          }
          if (last) {
            this.deps.onActivity?.(false);
            log.error(`Chat request failed after ${candidates.length} model(s): ${String(err)}`);
            void vscode.window.showWarningMessage(
              vscode.l10n.t(
                "OmniRoute is temporarily unavailable (HTTP {0}). Retried {1} model(s) on {2} server(s) without success — please retry shortly.",
                String(status),
                String(candidates.length),
                String(serverCount)
              )
            );
            throw err;
          }
          log.warn(
            `Model ${cand.modelId} @${cand.routeId} transiently unavailable (HTTP ${status}) — trying fallback`
          );
          await delay(200);
        }
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
