# Changelog

## 0.1.0

Initial release.

- OmniRoute models in the Copilot Chat model picker (VS Code stable ≥1.104 and Insiders)
- Live model discovery from `GET /v1/models`, with per-model tool-calling and vision capabilities from the OmniRoute catalog (combos included)
- Streaming responses with full tool-calling round-trip (`tool_choice: required` honored)
- Image input for vision-capable models
- Status-bar connection indicator with quick-actions menu
- `Manage Connection` flow: server URL + API key in SecretStorage
- `Configure Coding CLI` command driving `omniroute setup-*` (Codex, Claude Code, Cline, Continue, Cursor, Aider, OpenCode, Goose, Crush, Qwen, Kilo, Roo)
- First-run onboarding with OmniRoute install pointers
