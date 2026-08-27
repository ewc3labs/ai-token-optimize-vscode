# Changelog

All notable changes to the "AI Token Optimizer" extension will be documented in this file.

## [0.1.1] - 2026-08-04

### Fixed
- **Windows: tools were never detected.** Binary lookup used `which`, which does not exist on Windows, so `codegraph` and `rtk` were reported missing even when installed. Detection now scans `PATH` natively (honouring Windows executable extensions) and then probes the directories installers actually use — `%APPDATA%\npm`, the npm prefix, winget links, scoop shims, chocolatey, `~/.cargo/bin` — so a manual install is picked up even when VS Code inherited a stale `PATH`.
- **Windows: installs failed.** npm-installed CLIs are `.cmd` shims, which Node cannot spawn directly; `npm install -g`, `codegraph init/sync/status`, and `codegraph install --yes` all failed. Every CLI call now runs through the resolver, which wraps shims in `cmd.exe`.
- **Windows: RTK could not be installed.** The installer only knew brew and `curl | sh`. It now downloads the published `rtk-x86_64-pc-windows-msvc.zip` release into `%LOCALAPPDATA%\ai-token-optimizer\bin` (probed directly, so no `PATH` change is required) and offers to add that folder to the user `PATH` for RTK's Copilot hook.
- **MCP entries that could never start.** `codegraph`, `context7`, and `token-cache` were written as bare commands; MCP hosts spawn without a shell. Entries now use an absolute path (wrapped in `cmd /c` for shims), and entries written by earlier versions are repaired automatically. On macOS/Linux a tool already on `PATH` stays a bare name so nvm version switches keep working.
- Case-insensitive path matching when deciding which project a changed file belongs to (`C:\repo` vs `c:\repo`).
- `sqlite3` telemetry reads no longer pass a backslash path in a `file:` URI.

### Added
- `aiTokenOptimizer.toolPaths` setting — point the extension at an existing `codegraph` / `rtk` / `sqlite3` / `node` / `npm` install when autodetection misses it.
- `AI Token Optimizer: Diagnose Tool Detection` command — reports where each tool resolved from and every directory searched.

## [0.1.0] - 2026-06-23

### Added
- Initial release
- Four token-reduction strategies (CodeGraph, RTK, Caveman, Session Management)
- Auto-generation of instruction files for Copilot, Claude Code, and Codex
- Profile-based strategy selection (Full, Debug, Planning, Review, Custom)
- Silent installation of optimization tools (codegraph, rtk-compress, caveman)
- MCP server configuration (Context7, CodeGraph)
- Before/after token savings dashboard
- Status bar indicator with click-to-configure
- CodeGraph file watcher with 30-second debounce reindexing
- Marker-based merge to preserve existing instruction file content
- Workspace-level configuration support
