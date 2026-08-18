import * as vscode from "vscode";
import { selectChatModels } from "./catalogFilter";
import { DEFAULT_BASE_URL, OmniRouteClient } from "./client";
import { estimateTokens, toOpenAiMessages, toOpenAiTools } from "./convert";
import type { ChatRequest, OmniRouteModel } from "./types";

export const SECRET_API_KEY = "omnicopilot.apiKey";

interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
}

export interface ProviderDeps {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  /** Called whenever a request round-trip settles, with success flag —
   * feeds the status bar without extra polling. */
  onActivity?: (ok: boolean) => void;
}

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

export class OmniRouteChatProvider
  implements vscode.LanguageModelChatProvider<OmniModelInfo>, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private cachedModels: OmniRouteModel[] = [];

  constructor(private readonly deps: ProviderDeps) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  /** Re-query the catalog and tell VS Code the model list changed. */
  async refresh(): Promise<void> {
    this.cachedModels = [];
    this._onDidChange.fire();
  }

  private async makeClient(): Promise<OmniRouteClient> {
    const baseUrl = getConfig().get<string>("baseUrl", DEFAULT_BASE_URL);
    const apiKey = await this.deps.context.secrets.get(SECRET_API_KEY);
    return new OmniRouteClient({ baseUrl, apiKey: apiKey || undefined });
  }

  // ── Model discovery ─────────────────────────────────────────────────────

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const client = await this.makeClient();

    try {
      this.cachedModels = await client.listModels(token);
      this.deps.onActivity?.(true);
    } catch (err) {
      this.deps.onActivity?.(false);
      this.deps.log.warn(`Model discovery failed: ${String(err)}`);
      if (!options.silent) {
        void this.offerConnectionHelp();
      }
      // Contract: with silent=true never prompt; an unreachable server simply
      // contributes no models until the user fixes the connection.
      return [];
    }

    const infos = this.toModelInfos(this.cachedModels);
    this.deps.log.info(`Listed ${infos.length} models from ${client.baseUrl}`);
    return infos;
  }

  private toModelInfos(models: OmniRouteModel[]): OmniModelInfo[] {
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
    for (const model of selectChatModels(models)) {
      if (filter && !filter.test(model.id)) continue;

      const contextLength = model.context_length ?? defaultContext;
      const maxOutputTokens = Math.min(model.max_completion_tokens ?? maxOutput, maxOutput);
      const caps = model.capabilities ?? {};
      const isCombo = model.owned_by === "combo";

      infos.push({
        id: model.id,
        name: model.display_name?.trim() || model.id,
        family: model.owned_by || "omniroute",
        version: "1.0.0",
        detail: isCombo ? "combo" : model.owned_by,
        tooltip: `OmniRoute · ${model.id}`,
        maxInputTokens: Math.max(contextLength - maxOutputTokens, 1024),
        maxOutputTokens,
        capabilities: {
          // Catalog knows tool_calling/vision per model; default to tools ON
          // (agent mode is the whole point) when the field is absent.
          toolCalling: caps.tool_calling !== false,
          imageInput: caps.vision === true,
        },
        omniModelId: model.id,
      });
    }
    return infos;
  }

  private async offerConnectionHelp(): Promise<void> {
    const cfg = getConfig();
    const baseUrl = cfg.get<string>("baseUrl", DEFAULT_BASE_URL);
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
    const client = await this.makeClient();
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

    log.debug(
      `Chat → ${model.omniModelId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)`
    );

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    try {
      for await (const event of client.streamChat(request, abort.signal)) {
        if (token.isCancellationRequested) break;
        if (event.kind === "text") {
          progress.report(new vscode.LanguageModelTextPart(event.text));
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
    } catch (err) {
      if (token.isCancellationRequested) return;
      this.deps.onActivity?.(false);
      log.error(`Chat request failed: ${String(err)}`);
      throw err;
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
