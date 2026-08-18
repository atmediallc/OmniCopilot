<h1 align="center">OmniRoute for GitHub Copilot Chat</h1>

<p align="center">
  <img src="assets/icon.png" alt="OmniCopilot" width="128">
</p>

<p align="center">
  <strong>1200+ AI models in your Copilot Chat — free &amp; forever free.</strong><br>
  <em>340+ providers, 90+ with free tiers, one endpoint. MIT open source.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=diegosouzapw.omnicopilot"><strong>🧩 Install from the VS Code Marketplace</strong></a><br>
  <a href="https://open-vsx.org/extension/diegosouzapw/omnicopilot"><strong>🔓 Install from Open VSX</strong></a> <em>(Cursor, Windsurf, VSCodium, Theia, code-server…)</em>
</p>

<p align="center">
  <a href="https://github.com/diegosouzapw/OmniRoute">🌐 OmniRoute on GitHub</a> •
  <a href="https://github.com/diegosouzapw/OmniCopilot">🔌 Extension source</a> •
  <a href="https://github.com/diegosouzapw/OmniRoute/issues">🐛 Issues</a>
</p>

---

**Don't replace Copilot — power it up.** No new sidebar to learn, no new chat UI. This extension drops every model from your [OmniRoute](https://github.com/diegosouzapw/OmniRoute) server — Kimi, Claude, GPT, Gemini, GLM, DeepSeek, Qwen, Llama and hundreds more across **340+ providers, 90+ of them with free tiers that stay free** — straight into the model picker of the Copilot Chat you already use. Including **VS Code Insiders**.

> 🆓 **No Copilot subscription required.** Since VS Code 1.122, provider models work without a GitHub sign-in and without any Copilot plan. VS Code + OmniRoute + this extension = a fully working AI chat with agent mode, for free.

## Why this extension?

- **1200+ models, one picker.** OmniRoute unifies 340+ providers (OpenAI-compatible, Anthropic, Gemini, Ollama, local, OAuth-based free tiers…) behind a single endpoint — **90+ providers are free, and free forever**. Every model it serves shows up in your Copilot Chat model dropdown.
- **Agent mode, tool calling, MCP, instructions — all of it still works.** This plugs into VS Code's native language-model provider API, so Copilot's entire stack now runs on the model *you* choose.
- **Vision included.** Models flagged as vision-capable in the OmniRoute catalog accept image attachments directly in chat.
- **Combos & auto-fallback.** OmniRoute combos (priority, round-robin, cost-optimized, fusion…) appear as regular models — pick one and get automatic failover across providers behind the scenes.
- **Online at a glance.** A status-bar dot and an Activity Bar panel show whether your OmniRoute server is reachable, how many models it serves, and where to configure everything — URL and API key included.
- **Speaks your language.** The UI ships in 42 languages, mirroring OmniRoute's own catalog — VS Code picks the one matching your display language automatically.
- **Configure your other tools too.** One command configures Codex CLI, Claude Code, Cline, Continue, Cursor, Aider and more to use OmniRoute — powered by the `omniroute` CLI under the hood.
- **Secure by default.** The API key lives in VS Code's SecretStorage (OS keychain), never in `settings.json`.

## Getting started

### 1. Run OmniRoute (60 seconds)

```bash
npm install -g omniroute
omniroute        # dashboard at http://localhost:20128
```

Add your providers/keys in the dashboard — or use the built-in free ones. Full guide: [github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute).

Already running OmniRoute somewhere else (home server, VPS, tunnel)? Point the extension at it — see below.

### 2. Install this extension

Search for **"OmniRoute"** in the VS Code Extensions view — it resolves from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=diegosouzapw.omnicopilot) on VS Code
and from [Open VSX](https://open-vsx.org/extension/diegosouzapw/omnicopilot) on forks like Cursor,
Windsurf and VSCodium. Or grab the `.vsix` from the [releases](https://github.com/diegosouzapw/OmniCopilot/releases).

### 3. Pick a model

1. Open Copilot Chat and click the **model picker**
2. Choose **Manage Models…** → **OmniRoute**
3. Tick the models you want — they now live in your picker

That's it. If OmniRoute runs on the default `http://localhost:20128`, there is nothing to configure.

## Remote server / API key

Click the **OmniRoute icon in the Activity Bar** (or run `OmniRoute: Manage Connection`, or click the status-bar dot) to open the connection panel:

- **Server URL** — e.g. `http://my-vps:20128` (the `/v1` suffix is added automatically)
- **API key** — only if your OmniRoute requires one (`REQUIRE_API_KEY`); stored in the OS keychain
- **Save & Test** — instant feedback with the live model count

## Configure your coding CLIs

Run **`OmniRoute: Configure Coding CLI`** and pick a tool — the extension drives the `omniroute` CLI to generate ready-to-use profiles:

| Tool | What you get |
| --- | --- |
| Codex CLI | `codex --profile glm52` style profiles in `~/.codex` |
| Claude Code | `omniroute launch --profile <name>` launch profiles |
| Cline / Roo / Kilo | Extension settings pointed at OmniRoute |
| Continue / Cursor / Aider / Goose / Crush / OpenCode / Qwen Code | Tool-native config |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `omnicopilot.baseUrl` | `http://localhost:20128` | OmniRoute server root (local or remote) — `/v1` is appended automatically |
| `omnicopilot.modelFilter` | *(empty)* | Substring/regex to limit which models are listed |
| `omnicopilot.maxOutputTokens` | `16384` | Output budget reserved per response |
| `omnicopilot.defaultContextLength` | `128000` | Context assumed when the catalog omits it |
| `omnicopilot.statusBar` | `true` | Show the connection dot |
| `omnicopilot.healthCheckIntervalSeconds` | `30` | Probe frequency |
| `omnicopilot.dashboardOpen` | `external` | Open the dashboard in the browser, or in a VS Code tab (`editor`) — see below |
| `omnicopilot.cliPath` | `omniroute` | Path to the OmniRoute CLI |

### Dashboard inside VS Code

Set `omnicopilot.dashboardOpen` to `editor` to open the OmniRoute dashboard in a VS Code tab
instead of your browser. This needs the server to allow embedding, which is opt-in — start
OmniRoute with **`DASHBOARD_ALLOW_EMBED=vscode`** (available since the CSP opt-in landed in
[OmniRoute #10273](https://github.com/diegosouzapw/OmniRoute/issues/10273)). Without it the
page refuses to frame and the extension falls back to the external browser, so nothing breaks
either way.

## How the model list is built

Curious why the picker shows the number of models it shows, or why a provider you never
configured is in there? → **[`docs/CATALOG.md`](docs/CATALOG.md)** explains the duplicate-prefix
mode, the non-chat filter and the free/keyless providers, with measured numbers.

## Good to know

- **Chat, agent mode and utility tasks** run through your OmniRoute models. Inline code completions and embeddings-based features are outside VS Code's provider API and still require GitHub Copilot.
- On **Copilot Business/Enterprise**, admins can disable third-party model providers via the "Bring Your Own Language Model Key" policy.
- Requires VS Code **1.104+** (older versions than 1.122 also need a signed-in Copilot plan — that's a VS Code rule, not ours).

## Free & open source

OmniRoute is MIT-licensed and free forever — ⭐ [star it on GitHub](https://github.com/diegosouzapw/OmniRoute) and join the project. This extension is MIT too; issues and PRs welcome at [diegosouzapw/OmniCopilot](https://github.com/diegosouzapw/OmniCopilot). Maintainers publishing a new version: see [`docs/PUBLISHING.md`](docs/PUBLISHING.md) (Marketplace + Open VSX).

---

*OmniRoute is an independent open-source project, not affiliated with GitHub or Microsoft. GitHub Copilot is a trademark of GitHub, Inc.*
