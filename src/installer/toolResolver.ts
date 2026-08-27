// Cross-platform binary resolution — the single place that answers "where is
// `codegraph` / `rtk` / `npm` / `sqlite3` on this machine, and how do I run it?"
//
// Why this exists: the extension used to shell out to `which <bin>`, which does
// not exist on Windows, so every tool looked missing there even when installed.
// Two further Windows-only traps are handled here as well:
//   1. npm-installed CLIs are `.cmd`/`.ps1` shims, and Node refuses to spawn a
//      `.cmd` without a shell (ENOENT / EINVAL since Node 18.20) — so a resolved
//      shim is invoked through `cmd.exe /d /s /c` with verbatim arguments.
//   2. VS Code inherits the PATH from whatever launched it, so a freshly
//      installed tool in `%APPDATA%\npm` is frequently absent from PATH until
//      the machine is restarted. Known install directories are therefore probed
//      directly, in addition to PATH.
//
// Pure Node — no `vscode` import, so it stays usable from the bundled MCP
// server and unit-testable outside the extension host.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { memoizeTtl, invalidateTtl } from '../cache/ttlCache';

export const IS_WINDOWS = process.platform === 'win32';

const RESOLVE_TTL_MS = 60_000;
const NPM_PREFIX_TTL_MS = 10 * 60_000;
const TTL_KEY_PREFIX = 'tool:';

export type ToolSource = 'override' | 'path' | 'known-dir';

export interface ResolvedTool {
  /** Logical name asked for, e.g. `codegraph`. */
  name: string;
  /** Absolute path to the executable (or shim) that should be invoked. */
  path: string;
  /** Directory containing it — used for PATH hints in diagnostics. */
  dir: string;
  /** How it was found. `known-dir` means it is installed but not on PATH. */
  source: ToolSource;
  /** True for `.cmd`/`.bat` shims, which must be run through `cmd.exe`. */
  needsShell: boolean;
}

// ─── user overrides (aiTokenOptimizer.toolPaths) ──────────────────────────────

let overrides: Record<string, string> = {};

/**
 * Explicit per-tool paths from settings. Takes precedence over PATH so a user
 * with a non-standard install (or several) can point the extension at it.
 */
export function setToolPathOverrides(next: Record<string, string | undefined>): void {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(next)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      cleaned[name] = expandHome(value.trim());
    }
  }
  const changed = JSON.stringify(cleaned) !== JSON.stringify(overrides);
  overrides = cleaned;
  if (changed) { invalidateToolCache(); }
}

function expandHome(p: string): string {
  if (p === '~') { return os.homedir(); }
  if (p.startsWith('~/') || p.startsWith('~\\')) { return path.join(os.homedir(), p.slice(2)); }
  return p;
}

// ─── executable probing ───────────────────────────────────────────────────────

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) { return false; }
    if (IS_WINDOWS) { return true; }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Windows extensions we know how to launch, most-preferred first. Deliberately
 * narrower than PATHEXT — that includes `.JS`/`.VBS`, which would resolve to a
 * script we'd hand to wscript. An npm global install writes `<bin>`, `<bin>.cmd`
 * and `<bin>.ps1`; only the `.cmd` is usable here, so it must outrank the rest.
 */
const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

function candidateFileNames(bin: string): string[] {
  if (!IS_WINDOWS) { return [bin]; }
  if (path.extname(bin)) { return [bin]; }
  // No bare-name fallback on Windows: npm's extensionless shim is a bash script
  // that cannot be spawned, and resolving to it would make every later call
  // fail instead of cleanly reporting the tool as missing.
  return WINDOWS_EXTENSIONS.map(ext => bin + ext);
}

function findInDir(dir: string, bin: string): string | null {
  for (const name of candidateFileNames(bin)) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) { return candidate; }
  }
  return null;
}

function pathDirs(): string[] {
  const raw = process.env.PATH || process.env.Path || '';
  return raw
    .split(path.delimiter)
    .map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(entry => entry.length > 0);
}

/** `npm config get prefix`, resolved from PATH only so it cannot recurse. */
function npmGlobalBinDirs(): string[] {
  return memoizeTtl(`${TTL_KEY_PREFIX}npm-prefix`, NPM_PREFIX_TTL_MS, () => {
    const npm = resolveFromPath('npm');
    if (!npm) { return []; }
    const r = runResolved(npm, ['config', 'get', 'prefix'], { timeoutMs: 8000 });
    const prefix = (r.stdout ?? '').trim().split(/\r?\n/).pop()?.trim();
    if (!prefix || prefix === 'undefined' || !fs.existsSync(prefix)) { return []; }
    // On Windows the prefix *is* the bin dir; elsewhere binaries live in bin/.
    return IS_WINDOWS ? [prefix] : [path.join(prefix, 'bin'), prefix];
  });
}

/**
 * Directory this extension installs downloaded binaries into (Windows RTK).
 * Kept out of PATH deliberately — resolution finds it without touching the
 * user's environment; adding it to PATH is a separate, opt-in action.
 */
export function managedBinDir(): string {
  if (IS_WINDOWS) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ai-token-optimizer', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

/** Well-known install locations, probed when a tool is not on PATH. */
export function knownInstallDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [managedBinDir()];

  if (IS_WINDOWS) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    dirs.push(
      path.join(appData, 'npm'),                                  // npm -g default
      path.join(localAppData, 'npm'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),    // winget shims
      path.join(home, 'scoop', 'shims'),                          // scoop
      path.join(programData, 'chocolatey', 'bin'),                // chocolatey
      path.join(home, '.cargo', 'bin'),                           // cargo install
      path.join(home, '.local', 'bin'),                           // rtk docs' suggestion
      path.join(home, 'bin'),
      path.join(programFiles, 'nodejs'),
      path.join(localAppData, 'Programs', 'nodejs'),
      // Windows PowerShell — the installer's download/PATH helper needs it even
      // if the user's PATH has been trimmed down.
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    );
  } else {
    dirs.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, 'bin'),
    );
  }

  dirs.push(...npmGlobalBinDirs());
  return Array.from(new Set(dirs));
}

function toResolved(name: string, file: string, source: ToolSource): ResolvedTool {
  const ext = path.extname(file).toLowerCase();
  return {
    name,
    path: file,
    dir: path.dirname(file),
    source,
    needsShell: IS_WINDOWS && (ext === '.cmd' || ext === '.bat'),
  };
}

function resolveFromPath(name: string): ResolvedTool | null {
  for (const dir of pathDirs()) {
    const hit = findInDir(dir, name);
    if (hit) { return toResolved(name, hit, 'path'); }
  }
  return null;
}

function resolveUncached(name: string): ResolvedTool | null {
  const override = overrides[name];
  if (override) {
    // A directory override is allowed — treat it as "look for the binary here".
    let target: string | null = null;
    if (isExecutableFile(override)) {
      target = override;
    } else {
      try {
        if (fs.statSync(override).isDirectory()) { target = findInDir(override, name); }
      } catch { /* falls through to the not-found log below */ }
    }
    if (target) { return toResolved(name, target, 'override'); }
    // A bad override must not silently mask a working PATH install.
  }

  const onPath = resolveFromPath(name);
  if (onPath) { return onPath; }

  for (const dir of knownInstallDirs()) {
    const hit = findInDir(dir, name);
    if (hit) { return toResolved(name, hit, 'known-dir'); }
  }
  return null;
}

/** Locate a tool. Memoized for 60s — probing is filesystem-only and cheap. */
export function resolveTool(name: string): ResolvedTool | null {
  return memoizeTtl(`${TTL_KEY_PREFIX}resolve:${name}`, RESOLVE_TTL_MS, () => resolveUncached(name));
}

export function isBinaryAvailable(name: string): boolean {
  return resolveTool(name) !== null;
}

/** Drop cached resolutions — call after installing or changing tool paths. */
export function invalidateToolCache(name?: string): void {
  invalidateTtl(name ? `${TTL_KEY_PREFIX}resolve:${name}` : TTL_KEY_PREFIX);
}

/** Human-readable resolution result for the Output channel. */
export function describeTool(name: string): string {
  const tool = resolveTool(name);
  if (!tool) { return 'not found'; }
  if (tool.source === 'known-dir') {
    return `${tool.path} (installed but NOT on PATH — resolved directly)`;
  }
  return `${tool.path}${tool.source === 'override' ? ' (from aiTokenOptimizer.toolPaths)' : ''}`;
}

// ─── execution ────────────────────────────────────────────────────────────────

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type RunResult = SpawnSyncReturns<string>;

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * `cmd.exe` argv for a shim invocation. Exported for tests, which must be able
 * to check the Windows quoting rules while running on macOS/Linux.
 * `windowsVerbatimArguments` is required alongside this — Node would otherwise
 * re-quote the already-quoted command line and cmd would reject it.
 */
export function cmdInvocation(file: string, args: string[]): string[] {
  const line = [file, ...args].map(quoteForCmd).join(' ');
  return ['/d', '/s', '/c', `"${line}"`];
}

/** Runs an already-resolved tool, going through cmd.exe only for shims. */
export function runResolved(tool: ResolvedTool, args: string[], opts: RunOptions = {}): RunResult {
  const base = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf-8' as const,
    timeout: opts.timeoutMs ?? 10_000,
    stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[],
  };

  if (tool.needsShell) {
    return spawnSync(process.env.ComSpec || 'cmd.exe', cmdInvocation(tool.path, args), {
      ...base,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(tool.path, args, base);
}

function missingToolResult(name: string): RunResult {
  return {
    pid: -1,
    output: [],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: new Error(`${name} not found — install it, or set aiTokenOptimizer.toolPaths.${name}`),
  };
}

/**
 * Resolve + run in one call. Never throws: a missing tool comes back as a
 * result with `error` set, matching spawnSync's own failure shape.
 */
export function runTool(name: string, args: string[], opts: RunOptions = {}): RunResult {
  const tool = resolveTool(name);
  if (!tool) { return missingToolResult(name); }
  return runResolved(tool, args, opts);
}

/** True when the process ran and exited 0. */
export function ranOk(result: RunResult): boolean {
  return !result.error && result.status === 0;
}

/** Combined stdout+stderr, for output that tools split arbitrarily. */
export function combinedOutput(result: RunResult): string {
  return (result.stdout ?? '') + (result.stderr ?? '');
}

// ─── MCP server entries ───────────────────────────────────────────────────────

export interface McpCommandSpec {
  command: string;
  args: string[];
}

/**
 * Command/args for launching a tool as an MCP stdio server.
 *
 * MCP hosts (VS Code, Claude Code) spawn these without a shell, so a bare
 * `codegraph` fails on Windows twice over: PATH may not contain the npm bin
 * dir, and the target is a `.cmd`. Emitting an absolute path — wrapped in
 * `cmd /c` for shims — works on every host. Returns null when unresolvable, so
 * callers can skip writing an entry that could not possibly start.
 */
export function mcpCommandFor(name: string, args: string[]): McpCommandSpec | null {
  const tool = resolveTool(name);
  return tool ? toMcpSpec(tool, args) : null;
}

/** Pure form of `mcpCommandFor` — exported so the shim path is testable anywhere. */
export function toMcpSpec(tool: ResolvedTool, args: string[]): McpCommandSpec {
  if (tool.needsShell) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/c', tool.path, ...args] };
  }
  // On POSIX, a tool already on PATH stays a bare name: the MCP host inherits
  // the same PATH this process has, and hard-coding e.g. an nvm-versioned path
  // would break the entry the next time the user switches Node versions.
  // Windows gets the absolute path either way — bare names there are the bug.
  if (!IS_WINDOWS && tool.source === 'path') {
    return { command: tool.name, args };
  }
  return { command: tool.path, args };
}

/** Case-insensitive path containment — `C:\Foo` vs `c:\foo` on Windows. */
export function pathStartsWith(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return IS_WINDOWS ? resolved.toLowerCase() : resolved;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
