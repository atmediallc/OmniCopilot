import { ContextBudgetError } from "./contextBudget";
import { OmniRouteError, describeFetchError } from "./client";

/** Maps a terminal chat failure to a message that tells the user what to do
 * next, instead of surfacing the raw upstream text. Pure module: no vscode
 * import, fully unit-testable. Command references use palette titles (the
 * `OmniRoute` category prefix is stable across locales). */
export function actionableFailureMessage(
  err: unknown,
  modelId: string,
  routeName?: string
): string {
  const where = routeName ? ` on "${routeName}"` : "";
  if (err instanceof ContextBudgetError) {
    return (
      `Request does not fit the context budget of ${modelId}${where}: system prompt, current message ` +
      `and tools exceed the available input. Pick a larger-context model, lower "omnicopilot-dev.maxTools", ` +
      `or shorten the conversation. (${err.code})`
    );
  }
  if (err instanceof OmniRouteError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return (
        `Authentication failed${where} (HTTP ${status}): the API key is missing or invalid. ` +
        `Run "OmniRoute: Set API Key" from the command palette and retry.`
      );
    }
    if (status === 404 && /model|not[ _-]?found/i.test(err.message)) {
      return (
        `Model "${modelId}" was not found${where}: the catalog entry is stale. ` +
        `Run "OmniRoute: Refresh Models" and pick the model again.`
      );
    }
    if (status === 429 || status === 503) {
      return (
        `All configured servers are busy or rate-limited${where} (last error: ${describeFetchError(err)}). ` +
        `Wait a few seconds and retry; configure a second server for automatic failover.`
      );
    }
    if (err.stall) {
      return (
        `The server accepted the request but stopped responding${where} (timeout). ` +
        `It was NOT retried to avoid billing you twice — check the server load and retry.`
      );
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return (
        `Request rejected${where}: ${describeFetchError(err)}. ` +
        `Retrying as-is will fail the same way — check the model, tools, or key first.`
      );
    }
  }
  return describeFetchError(err);
}
