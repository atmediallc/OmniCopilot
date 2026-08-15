# Changelog

## 1.0.1

Comprehensive quality and security audit fixes:

- **Metrics & Usage Performance**: Fixed token overcounting and high CPU / token estimation overhead by reporting usage metrics exactly once upon stream completion.
- **Provider Fallback Reliability**: Fixed dead ternary condition during candidate fallback selection when primary route is configured.
- **Vendor Slot Safety**: Capped maximum vendor routes registered to `vscode.lm.registerLanguageModelChatProvider` at 10 slots to prevent vendor route collisions.
- **Concurrency Control**: Added mutex sync locks and try-catch error guards around provider registration to prevent activation race conditions.
- **Status Bar & Webview Metrics**: Preserved custom server names in metrics tracking and status bar popups.
- **Security & Webview Hardening**: Enforced Content-Security-Policy (CSP) headers and set `localResourceRoots` across webview panels.
- **Internationalization (l10n)**: Defaulted source strings to English and updated localization bundles (`bundle.l10n.json`, `bundle.l10n.es.json`).
- **Test Coverage**: Added automated unit tests for metrics tracking, token estimation, and provider initialization.

## 1.0.0

First public release. 🎉

- **OmniRoute models in the Copilot Chat model picker** (VS Code stable ≥1.104 and Insiders) — live discovery from `GET /v1/models` with per-model tool-calling and vision capabilities from the OmniRoute catalog, combos included
- **Streaming responses** with full tool-calling round-trip (`tool_choice: required` honored) and image input for vision-capable models
- **Activity Bar panel**: connection status, model count, server URL and API key (SecretStorage / OS keychain), quick actions
- **Status-bar connection dot** with instant feedback from live requests
- **Localized in 42 languages** — mirroring the OmniRoute catalog (pt-BR, es, fr, de, ja, ko, zh-CN, zh-TW, ru, ar, hi, …)
- **Open Dashboard** in the external browser or in a VS Code editor tab (Simple Browser; editor mode requires an OmniRoute build that allows embedding)
- **Configure Coding CLI** command driving `omniroute setup-*` (Codex, Claude Code, Cline, Continue, Cursor, Aider, OpenCode, Goose, Crush, Qwen, Kilo, Roo)
- First-run onboarding with OmniRoute install pointers

## 0.1.0

Internal preview.
