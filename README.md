# AI Token Optimizer

A VS Code extension that automatically reduces token consumption for **Claude Code**, **GitHub Copilot**, and **OpenAI Codex** by up to ~90% per session.

## Features

### 🚀 Auto-Apply on Workspace Open
- Detects installed AI tools (Copilot, Claude Code, Codex)
- Generates optimized instruction files automatically
- Installs CodeGraph, RTK, and Caveman tools silently
- Configures MCP servers for documentation and search

### 📋 Four Token-Reduction Strategies

| Strategy | Description | Estimated Savings |
|----------|-------------|-------------------|
| **CAP-1: CodeGraph** | Semantic search pre-indexing — AI finds files via query instead of grepping | ~25% fewer file reads |
| **CAP-2: RTK Compression** | CLI/log output compressed before AI reads it | ~30% output reduction |
| **CAP-3: Caveman Verbosity** | AI response length constrained by mode (light/full/ultra) | 20-50% shorter responses |
| **CAP-4: Session Management** | Context hygiene, model routing, session clearing | ~15% context reduction |

### 🎯 Profile-Based Strategy Selection

Switch profiles based on your current task:

- **Full** — All strategies active (maximum savings)
- **Debug** — Output compression disabled (need full stack traces)
- **Planning** — Verbosity control disabled (need detailed analysis)
- **Review** — Session clearing disabled (need full context history)
- **Custom** — Pick individual strategies

### 📊 Before/After Dashboard

Visual comparison showing estimated token savings per strategy with real-world scenario breakdowns.

### 🔧 MCP Server Configuration

Automatically configures:
- **Context7** — Documentation lookup (reduces hallucination, saves tokens)
- **CodeGraph** — Semantic search as MCP tool for AI agents

## Usage

### Automatic (Default)
The extension activates on startup and:
1. Generates `.github/copilot-instructions.md` for GitHub Copilot
2. Generates `CLAUDE.md` for Claude Code
3. Generates `.codex/instructions.md` for Codex
4. Installs optimization tools (CodeGraph, RTK, Caveman)
5. Configures MCP servers

### Manual Commands

| Command | Description |
|---------|-------------|
| `AI Token Optimizer: Select Optimization Profile` | Switch between Full/Debug/Planning/Review/Custom |
| `AI Token Optimizer: Toggle All Strategies` | Enable/disable the extension entirely |
| `AI Token Optimizer: Regenerate Instruction Files` | Force regenerate all instruction files |
| `AI Token Optimizer: Show Savings Dashboard` | Open the before/after comparison panel |
| `AI Token Optimizer: Reindex CodeGraph` | Manually trigger code graph re-indexing |
| `AI Token Optimizer: Install Optimization Tools` | Re-run tool installation |
| `AI Token Optimizer: Configure MCP Servers` | Re-run MCP server configuration |

### Status Bar

Click the `⚡ Full (4/4)` status bar item to quickly switch profiles or toggle strategies.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `aiTokenOptimizer.enabled` | `true` | Enable/disable the extension |
| `aiTokenOptimizer.autoApply` | `true` | Auto-generate instruction files on workspace open |
| `aiTokenOptimizer.targetTools` | `["copilot", "claude", "codex"]` | Which AI tools to target |
| `aiTokenOptimizer.profile` | `"full"` | Active optimization profile |
| `aiTokenOptimizer.activeStrategies` | all true | Individual strategy toggles (for custom profile) |
| `aiTokenOptimizer.verbosityLevel` | `"full"` | Caveman mode: light (~20%), full (~35%), ultra (~50%) |
| `aiTokenOptimizer.preserveExistingInstructions` | `true` | Merge with existing instruction files |
| `aiTokenOptimizer.autoInstallTools` | `true` | Silently install optimization tools |
| `aiTokenOptimizer.configureMcpOnActivation` | `true` | Auto-configure MCP servers |

## How It Works

### Instruction File Injection

The extension generates tool-specific instruction files that AI coding tools read automatically:

```
.github/copilot-instructions.md  ← GitHub Copilot reads this
CLAUDE.md                         ← Claude Code reads this
.codex/instructions.md            ← Codex reads this
```

Content between `<!-- AI-TOKEN-OPTIMIZER:START -->` and `<!-- AI-TOKEN-OPTIMIZER:END -->` markers is managed by the extension. Your existing content outside these markers is preserved.

### Tool Installation

On activation, the extension silently installs:
- **codegraph** — Semantic code indexing
- **rtk-compress** — CLI output compression
- **caveman** — Response verbosity control

### Strategy Constraints

The extension respects task-type constraints from the spec:
- Output compression is **disabled during debugging** (need full error traces)
- Verbosity control is **disabled during planning** (need complete analysis)
- Session clearing is **disabled during review** (need full context)

## Requirements

- VS Code 1.85.0+
- Node.js (for npm package installation)
- At least one AI coding tool: GitHub Copilot, Claude Code, or Codex

## Installation

### From VSIX (Local)
```bash
code --install-extension ai-token-optimizer-0.1.0.vsix
```

### From Source
```bash
cd ai-token-optimizer-vscode
npm install
npm run build
npx vsce package
code --install-extension ai-token-optimizer-0.1.0.vsix
```

## Development

```bash
# Install dependencies
npm install

# Watch mode (continuous compilation)
npm run watch

# Build for production
npm run build

# Run tests
npm test

# Package extension
npm run package
```

Press **F5** in VS Code to launch the Extension Development Host for testing.

## Architecture

```
src/
├── extension.ts          # Entry point — orchestrates activation
├── config.ts             # Configuration management & profiles
├── constants.ts          # Markers, IDs, descriptions
├── generators/
│   ├── base.ts           # Abstract generator with merge logic
│   ├── copilot.ts        # .github/copilot-instructions.md
│   ├── claude.ts         # CLAUDE.md
│   ├── codex.ts          # .codex/instructions.md
│   └── index.ts          # Generator orchestration
├── installer/
│   ├── packageManager.ts # Detect npm/yarn/pnpm
│   ├── installer.ts      # Silent tool installation
│   └── index.ts
├── mcp/
│   ├── configurator.ts   # MCP server configuration
│   └── index.ts
├── strategies/
│   ├── codegraph.ts      # File watcher & reindex
│   └── index.ts
└── ui/
    ├── statusBar.ts      # Status bar indicator
    ├── quickPick.ts      # Profile/strategy picker
    └── dashboard.ts      # Webview savings dashboard
```

## License

MIT
