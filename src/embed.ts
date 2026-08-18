/**
 * Can the dashboard be rendered inside a VS Code editor tab?
 *
 * The Simple Browser is an iframe, so the server has to allow framing. OmniRoute
 * ships `frame-ancestors 'none'` + `X-Frame-Options: DENY` by default and only
 * relaxes them when the operator builds with `DASHBOARD_ALLOW_EMBED=vscode`
 * (a build-time knob — setting the variable on an existing build does nothing).
 *
 * Without this check `simpleBrowser.show` still *succeeds* — the command runs, the
 * tab opens, and the iframe renders a "refused to connect" page. The user gets a
 * broken tab instead of their dashboard, so probe the headers and fall back to the
 * external browser when framing is blocked.
 */

/** `vscode-webview:` is the origin the Simple Browser frames from. */
const VSCODE_FRAME_ORIGIN = "vscode-webview:";

function frameAncestorsOf(csp: string): string | null {
  for (const directive of csp.split(";")) {
    const trimmed = directive.trim();
    if (/^frame-ancestors\b/i.test(trimmed)) {
      return trimmed.slice("frame-ancestors".length).trim().toLowerCase();
    }
  }
  return null;
}

/**
 * Decide from response headers whether a VS Code webview may frame the page.
 * Conservative: anything that reads as a block is treated as a block.
 */
export function isFramingAllowed(headers: {
  get(name: string): string | null;
}): boolean {
  const xfo = (headers.get("x-frame-options") ?? "").trim().toLowerCase();
  // SAMEORIGIN also blocks us — the webview is a different origin.
  if (xfo === "deny" || xfo === "sameorigin") return false;

  const csp = headers.get("content-security-policy") ?? "";
  const ancestors = csp ? frameAncestorsOf(csp) : null;
  if (ancestors === null) return true; // no directive → not blocked by CSP
  if (ancestors === "'none'") return false;

  return ancestors.split(/\s+/).some((src) => src === "*" || src.startsWith(VSCODE_FRAME_ORIGIN));
}
