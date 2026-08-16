import { fmtTokens } from "../metrics";

/** Pure, framework-free description of what the status bar should render.
 * Produced by the adapter (statusBar.ts), rendered here so the presentation
 * logic stays unit-testable without the VS Code API. */

export type StatusKind =
  | "checking"
  | "online"
  | "partial"
  | "offline"
  | "streaming"
  | "error";

export interface StatusServer {
  routeId: string;
  name: string;
  online: boolean;
  latencyMs?: number;
  tokens: number;
  requests: number;
}

export interface StatusSnapshot {
  status: StatusKind;
  servers: StatusServer[];
  /** Most recent chat round-trip (model + token counts). */
  usage?: {
    serverName: string;
    modelName: string;
    inputTokens: number;
    outputTokens: number;
  };
  /** Final failure message of the last request, when it errored out. */
  lastError?: string;
  lastResponseAt?: number;
  /** In-flight chat requests across all provider slots. */
  activeRequestCount: number;
  /** Model currently streaming, when any. */
  activeModel?: string;
  /** How many fallback servers were tried during the last request. */
  fallbackCount: number;
}

/** One-line status-bar text: icon + server tally + avg latency + token readout. */
export function renderStatusText(snap: StatusSnapshot): string {
  let icon = "$(circle-filled)";
  switch (snap.status) {
    case "offline":
      icon = "$(circle-outline)";
      break;
    case "checking":
      icon = "$(sync~spin)";
      break;
    case "streaming":
      icon = "$(loading~spin)";
      break;
    case "error":
      icon = "$(error)";
      break;
    case "online":
    case "partial":
      break;
  }

  let text = `${icon} OmniRoute`;
  const online = snap.servers.filter((s) => s.online).length;
  if (snap.servers.length > 0) {
    text += ` ${online}/${snap.servers.length}`;
    const latencies = snap.servers.map((s) => s.latencyMs).filter((v): v is number => v !== undefined);
    if (latencies.length > 0) {
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      text += ` · ${avg}ms`;
    }
  }
  if (snap.activeRequestCount > 0 && snap.activeModel) {
    text += ` · ${snap.activeModel}`;
  }
  if (snap.usage) {
    text += ` · ${fmtTokens(snap.usage.inputTokens + snap.usage.outputTokens)}`;
  }
  return text;
}

/** Theme-color tokens by state; the adapter maps them to vscode.ThemeColor. */
export function statusColorTokens(snap: StatusSnapshot): { color?: string; background?: string } {
  switch (snap.status) {
    case "online":
      return { color: "testing.iconPassed" };
    case "partial":
      return { color: "testing.iconWarning" };
    case "offline":
      return { background: "statusBarItem.warningBackground" };
    case "error":
      return { color: "testing.iconFailed" };
    default:
      return {};
  }
}
