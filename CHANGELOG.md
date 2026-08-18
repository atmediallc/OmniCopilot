# Change Log

## 1.0.2

- **The in-editor dashboard no longer opens a broken tab.** `dashboardOpen: "editor"`
  only guarded against the Simple Browser command being missing, which is the wrong
  failure mode: against a server that sends `X-Frame-Options: DENY` the command
  *succeeds* and the iframe renders a "refused to connect" page. The extension now
  checks the framing headers first and falls back to the external browser, explaining
  once that the server has to be **built** with `DASHBOARD_ALLOW_EMBED=vscode` — it is
  a build-time option, so setting the variable on an existing install is not enough.

## 1.0.1
- **No duplicate models in the picker**: Requests ?prefix=alias from OmniRoute and drops mirror rows.
- **Only conversational models reach the picker**: Filters out non-chat registries.
- **Multi-Route & Deleted Model Cleanup**: Automatically updates cache and prunes stale routes.
- **Metrics & Usage Performance**: Fixed token overcounting.

## 1.0.0
- Initial release.
