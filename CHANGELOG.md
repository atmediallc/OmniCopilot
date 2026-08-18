# Changelog

## 1.0.2

- **The in-editor dashboard no longer opens a broken tab.** `dashboardOpen: "editor"`
  only guarded against the Simple Browser command being missing, which is the wrong
  failure mode: against a server that sends `X-Frame-Options: DENY` the command
  *succeeds* and the iframe renders a "refused to connect" page. The extension now
  checks the framing headers first and falls back to the external browser, explaining
  once that the server has to be **built** with `DASHBOARD_ALLOW_EMBED=vscode` — it is
  a build-time option, so setting the variable on an existing install is not enough.

## 1.0.1

Catalog and configuration fixes, validated against a live OmniRoute instance
serving 2345 catalog entries.

- **No more duplicate models in the picker.** OmniRoute defaults to
  `MODELS_CATALOG_PREFIX_MODE=dual`, which advertises every model twice — once
  under the short alias prefix and once under the canonical provider prefix
  (`cc/claude-sonnet-4-6` *and* `claude/claude-sonnet-4-6`). The extension now
  requests `?prefix=alias`, and independently drops mirror rows via their
  `parent` back-reference so servers too old for that parameter are covered as
  well. On the validation instance this removed **949 duplicates** with **zero
  models lost**.
- **Only conversational models reach the picker.** The catalog also lists
  image, video, audio and rerank registries, which the server rejects outright
  on `/v1/chat/completions`. Responses-API models (every Codex/GPT-5.x entry)
  are kept — OmniRoute translates those transparently.
- **`/v1` no longer leaks into your settings.** Configure the server root
  (`http://localhost:20128`); the extension appends `/v1` per request. Values
  already stored with `/v1` keep working and are never doubled.

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
