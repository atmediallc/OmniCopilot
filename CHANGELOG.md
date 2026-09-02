# Change Log

## Unreleased

- **Agents window (experimental, opt-in).** `omnicopilot-dev.exposeToAgentsWindow` registers a
  second, agent-host-scoped set of entries for every tool-calling OmniRoute model, so they
  appear in the **Copilot Agents window** model picker. Requires the experimental VS Code
  setting `chat.agentHost.byokModels.enabled` and an agent-host restart; built on the proposed
  `targetChatSessionType` API, hence default-off. Closes
  [#14](https://github.com/diegosouzapw/OmniCopilot/issues/14).
- **Configurable stream idle timeout.** `omnicopilot-dev.idleTimeoutSeconds` lets you raise the
  30s default for slow reasoners or long tool calls that otherwise abort with
  *"OmniRoute went silent"*. Mirrors the existing `firstByteTimeoutSeconds` wiring.

## 1.2.0

- **The panel now shows your key's own spend.** A **My usage** section reads OmniRoute's
  self-service endpoint (`GET /api/usage/om-usage?format=json`) and renders the daily/weekly
  spend against its limit, the reset time, and each provider connection's quota side by side —
  Codex, Claude, OpenCode — instead of one provider's number. The three normal states are
  surfaced, not hidden behind a 0%: *usage not enabled for this key* (the `allowUsageCommand`
  flag is off by default), *nothing cached yet*, and — on a server too old for the JSON form —
  the section simply doesn't render. Closes
  [#12](https://github.com/diegosouzapw/OmniCopilot/issues/12) → resolves
  [#8](https://github.com/diegosouzapw/OmniCopilot/issues/8) once the OmniRoute side ships.
- **Settings are findable.** `OmniRoute: Open Settings` in the Command Palette and an
  **Extension settings** link in the panel — the discoverability half of
  [#10](https://github.com/diegosouzapw/OmniCopilot/issues/10).

## 1.1.0

- **Reasoning effort is forwarded to models that support extended thinking.**
  When VS Code offers an effort control next to the model, the choice now reaches
  OmniRoute as `reasoning_effort`; a new `omnicopilot.defaultReasoningEffort`
  setting covers the case where the editor does not expose one. Values use
  OmniRoute's canonical vocabulary (`none`/`low`/`medium`/`high`/`xhigh`) and the
  server downshifts a tier a model does not support, so asking for the top tier is
  always safe. The default only applies to models the catalog marks as
  reasoning-capable — sending the field to a model without thinking support is
  ignored at best and a 400 at worst. Reasoning models are now labelled
  "extended thinking" in the picker tooltip. Requested in
  [#7](https://github.com/diegosouzapw/OmniCopilot/issues/7) by @aliaksandrsen.
- **Security:** `sharp` 0.33 → 0.35 (high — inherited libvips CVE-2026-33327 /
  33328 / 35590 / 35591) and `esbuild` 0.24 → 0.28 (moderate — dev server could be
  read cross-origin). Both are build-time-only dependencies and never shipped
  inside the `.vsix`, so no published version was exploitable; `npm audit` is now
  clean.

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
