# AI Token Optimizer

A VS Code extension that reduces token consumption for **Claude Code**, **GitHub Copilot**, and **OpenAI Codex** by injecting token-efficiency instructions into the config files those tools already read, installing the supporting CLI tools, and wiring up MCP servers — automatically, on workspace open.

The extension has **zero runtime dependencies** (devDependencies only). Everything is written against Node's `fs`/`child_process` APIs and the `vscode` API.

---

## Table of Contents

- [How It Works](#how-it-works)
- [The Five Strategies (CAP-1 – CAP-5)](#the-five-strategies-cap-1--cap-5)
- [Profiles](#profiles)
- [Semantic Answer Cache (MCP Server)](#semantic-answer-cache-mcp-server)
- [Telemetry & Dashboard](#telemetry--dashboard)
- [Commands](#commands)
- [Settings](#settings)
- [Installation](#installation)
- [Development](#development)
- [Architecture](#architecture)
- [Observability Honesty Rule](#observability-honesty-rule)
- [Contributing](#contributing)
- [Owners](#owners)
- [License](#license)

---

## How It Works

The extension activates on `onStartupFinished` and runs an **auto-apply** pass:

1. **Generate instruction files** — writes CAP-1 – CAP-5 rules into whichever AI tool config files are targeted:

   | File | Read by |
   |------|---------|
   | `.github/copilot-instructions.md` | GitHub Copilot |
   | `CLAUDE.md` | Claude Code |
   | `.codex/instructions.md` | OpenAI Codex |

2. **Install supporting tools** — checks for and (with your consent) installs the real CLI tools the instructions reference.
3. **Configure MCP servers** — writes `context7`, `codegraph`, and `token-cache` server entries into `.vscode/settings.json` and the Claude MCP config.
4. **Start the CodeGraph watcher** — watches source files per configured project, debounces 30s, then runs `codegraph init` (first run) or `codegraph sync` (incremental).
5. **Show status** — a status bar item reflects the active profile and strategy count.

### Marker-based merge, never overwrite

Only the content between these markers is managed by the extension:

```
<!-- AI-TOKEN-OPTIMIZER:START -->
   ... managed block ...
<!-- AI-TOKEN-OPTIMIZER:END -->
```

Anything you write **outside** the markers is preserved untouched. If the markers are absent, the block is appended to the end of the file. Setting `preserveExistingInstructions` to `false` overwrites the whole file instead.

### Graceful degradation

If the `codegraph` or `rtk` binaries aren't installed, instruction files are **still** generated with full CAP guidance (telling the AI to invoke those commands directly). Nothing hard-fails activation because a binary is missing.

---

## The Five Strategies (CAP-1 – CAP-5)

| Strategy | What it does | How it's wired |
|----------|--------------|----------------|
| **CAP-1: CodeGraph** | Semantic code-graph pre-indexing. The AI locates symbols and files by querying the graph instead of grepping file-by-file. | `@colbymchenry/codegraph` installed globally via npm + exposed as an MCP server (`codegraph_explore`) |
| **CAP-2: RTK Output Compression** | A CLI proxy that filters command output *before* it reaches the model context — `rtk git status`, `rtk pytest`, `rtk cargo test`, etc. | `rtk` installed via Homebrew (or the upstream install script), wired as a **Copilot PreToolUse hook** so commands rewrite transparently |
| **CAP-3: Verbosity Control (Caveman)** | Constrains response length via instruction rules. Three levels: light (~20%), full (~35%), ultra (~50%). | `.cavemanrc` config file + instruction rules |
| **CAP-4: Session Management** | Context hygiene: `/compact` for routine work, `/clear` on task switches, `/model` routing to lighter models for lightweight tasks, `/context` audits. | Instruction rules + task-type routing table |
| **CAP-5: Semantic Answer Cache** | A local MCP server that caches answers on disk. Repeated or paraphrased questions are served from cache at **zero model tokens**. | `token-cache` MCP server (`dist/cache-server.js`), bundled with the extension |

> **RTK is hooks, not MCP.** The MCP configurator actively *deletes* any stray `rtk` MCP entry it finds — RTK integrates through the PreToolUse hook, not through MCP.

> **Installing CodeGraph and exposing it over MCP are two separate steps.** The npm install puts the `codegraph` binary on `$PATH`; adding the MCP server entry is what lets Copilot/Claude actually call `codegraph_explore`. Both must happen.

### Task-type routing

The generated instructions also teach the AI when to downshift models:

- **Lightweight** (use a lighter model): file navigation, renames/moves, formatting and lint fixes, boilerplate from templates, docs lookups.
- **Full-power** (keep the current model): architectural decisions, multi-file debugging, security review, performance work, multi-step refactors.

---

## Profiles

Profiles gate which strategies are active — strategy behavior is never hardcoded in generators, it always flows through `getEffectiveStrategies(profile)`.

| Profile | CAP-1 | CAP-2 | CAP-3 | CAP-4 | CAP-5 | Why |
|---------|:-----:|:-----:|:-----:|:-----:|:-----:|-----|
| **Full** | ✅ | ✅ | ✅ | ✅ | ✅ | Maximum savings |
| **Debug** | ✅ | ❌ | ✅ | ✅ | ✅ | Compression off — you need full stack traces |
| **Planning** | ✅ | ✅ | ❌ | ✅ | ✅ | Verbosity control off — you need complete analysis |
| **Review** | ✅ | ✅ | ✅ | ❌ | ✅ | Session clearing off — you need full context history |
| **Custom** | \* | \* | \* | \* | \* | Pick individual strategies via `activeStrategies` |

Switch profiles from the status bar (`⚡ Full (5/5)`) or via **AI Token Optimizer: Select Optimization Profile**.

### Standing constraints

Regardless of profile, the generated instructions state:

- Never compress error messages, stack traces, or security warnings.
- Disable output compression during active debugging.
- Disable verbosity control during architectural planning.
- Re-index CodeGraph after significant code changes.

---

## Semantic Answer Cache (MCP Server)

The `token-cache` MCP server (`src/mcp-server/cache-server.ts`, bundled to `dist/cache-server.js`) is a standalone stdio JSON-RPC 2.0 server launched by your AI tool as `node cache-server.js <workspaceRoot>`. It never imports `vscode`.

**Tools it exposes:**

| Tool | Purpose |
|------|---------|
| `cache_lookup` | Look up a cached answer *before* answering. Returns `{ hit, answer, exact, similarity, stale, storedAt }`. |
| `cache_store` | Store a reusable, self-contained answer for later reuse. |
| `cache_stats` | Entry count, total hits, estimated tokens saved. |

**Matching** is exact-key first, then fuzzy: queries are lowercased, camelCase-split, stopword-filtered and lightly stemmed, then compared with IDF-weighted cosine (≥ 0.7) *and* Jaccard (≥ 0.5). Single-token queries are exact-match only, by design — one shared token would otherwise match every question on that topic.

**Staleness** is scope-driven:
- `scope: "code"` (default) — the entry records the git HEAD it was stored at; when HEAD moves, hits come back `stale: true` so the AI verifies before reusing.
- `scope: "durable"` — concept explanations and how-tos that don't depend on code state; never go stale.

**Storage** lives at `.aicache/semantic-cache.json`, capped at 300 entries / 1 MB, with entries evicted 14 days after last access. Clear it any time with **AI Token Optimizer: Clear Semantic Cache**.

Answers about uncommitted or actively changing code should not be cached — the generated instructions say so explicitly.

---

## Telemetry & Dashboard

**AI Token Optimizer: Show Savings Dashboard** opens a webview (scripts disabled — all charts are static inline SVG) with:

- **Repository Intelligence** — real structural facts read straight from `.codegraph/codegraph.db` via the `sqlite3` CLI: files, directories, classes, interfaces, enums, methods, functions, graph nodes, graph relationships, index size, and per-language file counts. When `sqlite3` isn't available it falls back to `codegraph status` totals.
- **Modeled savings estimate** — a whole-repo baseline vs. graph-scoped-slice comparison. Always tagged `modeled: true` and labeled as an estimate in the UI.
- **Real RTK savings** — read from `rtk gain --format json --all --project`: total commands, input/output tokens, tokens saved, average savings %. These are actual recorded usage, not a benchmark.
- **Cache stats** — entries, lifetime hits, estimated tokens saved.
- **Growth trends** — the persisted history windowed into 24h / 7d / 30d / lifetime, rendered as sparklines. These trends are *real* repository growth, not inferred LLM data.

Snapshots persist to `.aicache/telemetry/` (a latest snapshot plus an append-only `history.jsonl`).

**Export** via **AI Token Optimizer: Export Telemetry** in **JSON**, **CSV**, or **Markdown**. Excel and PDF are intentionally omitted — both need third-party runtime libraries this extension forbids, and CSV opens directly in Excel/Sheets.

Disable collection entirely with `aiTokenOptimizer.telemetry.enabled: false`.

---

## Commands

| Command | Description |
|---------|-------------|
| `AI Token Optimizer: Select Optimization Profile` | Switch between Full / Debug / Planning / Review / Custom |
| `AI Token Optimizer: Toggle All Strategies` | Enable or disable the extension entirely |
| `AI Token Optimizer: Regenerate Instruction Files` | Force-regenerate all instruction files |
| `AI Token Optimizer: Show Savings Dashboard` | Open the metrics + savings webview |
| `AI Token Optimizer: Reindex CodeGraph` | Manually trigger a code graph re-index |
| `AI Token Optimizer: Validate CodeGraph Index` | Check that the index exists and is current |
| `AI Token Optimizer: Validate All Strategies` | Verify all five CAP strategies are actually configured and active; reports to the Output channel |
| `AI Token Optimizer: Manage CodeGraph Projects` | Pick which folders get indexed in a multi-repo workspace |
| `AI Token Optimizer: Install Optimization Tools` | Re-run tool installation |
| `AI Token Optimizer: Configure MCP Servers` | Re-run MCP server configuration |
| `AI Token Optimizer: Diagnose Tool Detection` | Show where each CLI tool resolved from, and every directory that was searched |
| `AI Token Optimizer: Clear Semantic Cache` | Empty the local answer cache |
| `AI Token Optimizer: Export Telemetry (JSON/CSV/Markdown)` | Export metrics and history to a file |

### Status bar

The `⚡ Full (5/5)` item shows the active profile and how many strategies are live. Click it to switch profiles. It turns amber when fewer than five strategies are active, and reads `⚡ Token Opt: OFF` when the extension is disabled. Hover for a per-strategy ✓/✗ breakdown.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aiTokenOptimizer.enabled` | `true` | Enable/disable the extension |
| `aiTokenOptimizer.autoApply` | `true` | Auto-generate instruction files on workspace open |
| `aiTokenOptimizer.targetTools` | `["copilot","claude","codex"]` | Which AI tools to generate instruction files for |
| `aiTokenOptimizer.profile` | `"full"` | Active optimization profile |
| `aiTokenOptimizer.activeStrategies` | all `true` | Per-strategy toggles: `codeGraph`, `outputCompression`, `verbosityControl`, `sessionManagement`, `semanticCache` (used when profile is `custom`) |
| `aiTokenOptimizer.verbosityLevel` | `"full"` | Caveman level: `light` (~20%), `full` (~35%), `ultra` (~50%) |
| `aiTokenOptimizer.preserveExistingInstructions` | `true` | Merge into existing instruction files instead of overwriting |
| `aiTokenOptimizer.autoInstallTools` | `true` | Offer to install CodeGraph and RTK on activation |
| `aiTokenOptimizer.configureMcpOnActivation` | `true` | Auto-configure MCP servers on activation |
| `aiTokenOptimizer.codeGraphProjects` | `[]` | Array of `{ name, path, enabled }` scoping which folders get indexed. Empty means all workspace folders |
| `aiTokenOptimizer.toolPaths` | `{}` | Explicit paths to `codegraph` / `rtk` / `sqlite3` / `node` / `npm` when they live somewhere the extension can't find on its own. Accepts a file or its folder |
| `aiTokenOptimizer.telemetry.enabled` | `true` | Collect repository metrics from the CodeGraph index for the dashboard |

---

## Installation

### Requirements

- VS Code **1.85.0+**
- Node.js (for the global npm install of CodeGraph)
- At least one AI coding tool: GitHub Copilot, Claude Code, or Codex
- Optional: Homebrew (macOS) for RTK — otherwise the upstream install script (macOS/Linux) or the published `rtk.exe` release archive (Windows) is used
- Optional: `sqlite3` CLI for the full telemetry breakdown (falls back to `codegraph status` totals without it — the usual case on Windows)

### From VSIX

```bash
code --install-extension ai-token-optimizer-0.1.0.vsix
```

### From source

```bash
git clone https://github.com/sbaala/ai-token-optimize-vscode.git
cd ai-token-optimize-vscode
npm install
npm run build
npx vsce package
code --install-extension ai-token-optimizer-0.1.0.vsix
```

### Tools installed by the extension

| Tool | Package | Method | License / Source |
|------|---------|--------|------------------|
| `codegraph` | `@colbymchenry/codegraph` | npm global (all platforms) | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) |
| `rtk` | `rtk` (Rust binary — **not** an npm package) | macOS/Linux: `brew install rtk`, falling back to the upstream `install.sh`. Windows: downloads `rtk-x86_64-pc-windows-msvc.zip` from the latest GitHub release into `%LOCALAPPDATA%\ai-token-optimizer\bin` | [rtk-ai/rtk](https://github.com/rtk-ai/rtk), Apache 2.0 |

Both are installed only after you confirm the prompt.

### Windows notes

- **Detection never uses `which`.** Tools are located by scanning `PATH` directly (honouring `PATHEXT`, so `.cmd`/`.exe` shims resolve) and then by probing the places installers actually use: `%APPDATA%\npm`, the npm prefix, winget links, scoop shims, chocolatey, `~/.cargo/bin`, and the extension's own `%LOCALAPPDATA%\ai-token-optimizer\bin`. A tool you installed by hand is picked up even when VS Code inherited a stale `PATH`.
- **npm-installed CLIs are `.cmd` shims**, which Node cannot spawn directly. They are invoked through `cmd.exe`, and MCP server entries are written as an absolute path (wrapped in `cmd /c` for shims) so shell-less MCP hosts can start them. Entries written by an older version that named a bare `codegraph`/`npx` are rewritten automatically.
- **If something still isn't found**, run `AI Token Optimizer: Diagnose Tool Detection` — it prints the resolved path for every tool plus every directory searched — and set `aiTokenOptimizer.toolPaths`, e.g.
  ```json
  "aiTokenOptimizer.toolPaths": {
    "codegraph": "C:\\Users\\you\\AppData\\Roaming\\npm\\codegraph.cmd",
    "rtk": "C:\\tools\\rtk.exe"
  }
  ```
- **RTK's Copilot hook needs `rtk` on your PATH**, since the hook shells out to a bare `rtk`. After a Windows install the extension offers to append its bin directory to your *user* PATH (never the system one); take it and reload the window, or add the folder yourself.

---

## Development

```bash
npm install          # install dependencies
npm run watch        # esbuild watch mode → dist/extension.js
npm run build        # production build (minified, no sourcemaps)
npm run compile      # tsc -p ./ — type-checks src/ and test/ (required before npm test)
npm run lint         # eslint src --ext ts
npm run compile && npm test   # compile, then run the VS Code integration suite
npm run package      # vsce package → .vsix
```

Press **F5** in VS Code to launch the Extension Development Host for manual testing.

**Testing note:** there's no single-test filter. `npm test` runs `dist/test/suite/index.js` (Mocha, via `@vscode/test-electron`), which downloads and launches a VS Code instance and runs every suite under `test/suite/`. To iterate on one suite, temporarily narrow the `files` glob in `test/suite/index.ts` or `.only()` a `suite()`/`test()` block.

**Templates:** `templates/*.md` hold the raw markdown fragments the generators assemble. Change wording there rather than hunting for inline strings in generator code.

---

## Architecture

```
src/
├── extension.ts              # Entry point — activation, commands, auto-apply
├── config.ts                 # Configuration + profile → strategy mapping
├── constants.ts              # Markers, paths, tool install entries, descriptions
├── cache/
│   ├── store.ts              # SemanticCacheStore — disk-backed answer cache
│   ├── similarity.ts         # Tokenization, IDF, cosine + Jaccard matching
│   ├── callLog.ts            # MCP tool call log
│   └── ttlCache.ts           # Small TTL memoizer (e.g. `which` lookups)
├── mcp-server/
│   └── cache-server.ts       # Standalone token-cache MCP stdio server
├── generators/
│   ├── base.ts               # Abstract generator + marker merge logic
│   ├── copilot.ts            # .github/copilot-instructions.md
│   ├── claude.ts             # CLAUDE.md
│   ├── codex.ts              # .codex/instructions.md
│   └── index.ts              # Orchestration
├── installer/
│   ├── installer.ts          # Binary detection + consented install
│   ├── packageManager.ts     # npm/yarn/pnpm detection
│   └── index.ts
├── mcp/
│   ├── configurator.ts       # Writes context7/codegraph/token-cache entries; removes stray rtk
│   └── index.ts
├── session/
│   └── tracker.ts            # Per-window session stats
├── strategies/
│   ├── codegraph.ts          # File watcher, debounced init/sync, status
│   ├── validator.ts          # Verifies all five CAPs are actually active
│   ├── measurement.ts        # Real vs. unobservable measurement boundary
│   ├── rtkGain.ts            # Parses `rtk gain --format json`
│   └── index.ts
├── telemetry/
│   ├── repositoryCollector.ts # Tier-A: real metrics from codegraph.db
│   ├── codegraphDb.ts        # sqlite3 CLI access layer
│   ├── estimator.ts          # Modeled savings estimate (always tagged modeled)
│   ├── store.ts              # Latest snapshot + append-only history.jsonl
│   ├── analytics.ts          # 24h/7d/30d/lifetime windowing
│   ├── sparkline.ts          # Static inline SVG trends
│   ├── export.ts             # JSON / CSV / Markdown serialization
│   ├── types.ts
│   └── index.ts
└── ui/
    ├── statusBar.ts          # Profile + strategy-count indicator
    ├── quickPick.ts          # Profile / strategy picker
    ├── projectPicker.ts      # Multi-repo index scoping
    ├── dashboard.ts          # Webview (scripts disabled, static SVG)
    └── exportTelemetry.ts    # Export command driver
```

Full data-flow and sequence diagrams for activation, the installer, MCP configuration, and the CodeGraph watcher live in [ARCHITECTURE.md](ARCHITECTURE.md) — read that before making non-trivial changes to those paths.

---

## Observability Honesty Rule

**This extension is not in the LLM request path.** The actual model call and CodeGraph retrieval happen inside Copilot / Claude Code / Codex, which it cannot instrument. Therefore:

- Per-request LLM metrics (prompt/completion tokens, latency, cost) and per-query retrieval metrics are **not observable** and are never fabricated.
- Real numbers are read from local state (`codegraph.db`, `rtk gain`, the cache store) and reported as measured.
- Unobservable numbers are reported as `null` / `n/a`.
- Anything derived from assumptions is tagged `modeled` and labeled as an estimate in the UI and in exports.

Preserve this distinction in any contribution — do not turn an estimate into a number that reads as measured.

---

## Contributing

1. Branch off `main` — direct pushes to `main` are blocked.
2. Open a pull request. **At least one approving review is required** before merge.
3. Run `npm run lint` and `npm run compile && npm test` before requesting review.
4. Keep the architectural rules above intact: marker-based merge, profiles gating strategies, RTK-via-hooks (never MCP), graceful degradation, and the observability honesty rule.

---

## Owners

| Name | GitHub |
|------|--------|
| Vishal Gupta | [@vishalniit](https://github.com/vishalniit) |
| Balachandar Saminathan | [@sbaala](https://github.com/sbaala) |

---

## Credits & Acknowledgments

The concept and approach behind this extension were inspired by the token-optimization techniques presented in this video:

📺 **[Watch on YouTube](https://www.youtube.com/watch?v=UslVzxAkiZ0)**

Full credit to the original creator for the ideas that shaped these strategies. This extension packages those techniques into an automated VS Code workflow.

It also builds on these open-source tools:

- [CodeGraph](https://github.com/colbymchenry/codegraph) (`@colbymchenry/codegraph`) — semantic code-graph indexing (CAP-1)
- [RTK](https://github.com/rtk-ai/rtk) — CLI output compression, Apache 2.0 (CAP-2)

---

## License

[MIT](LICENSE)
