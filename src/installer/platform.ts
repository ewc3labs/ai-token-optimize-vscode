import { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process';

/**
 * Platform differences that decide whether a child process runs at all.
 *
 * Kept free of `vscode` so the rules can be tested directly, and kept in one
 * place because every call site here got the same thing wrong in the same way:
 * a POSIX assumption that fails closed on Windows and reads as "tool missing".
 */

/**
 * The command that reports where a binary lives.
 *
 * Windows has no `which`. `execSync('which rtk')` throws
 * `'which' is not recognized...`, the caller catches it, and the tool is
 * reported as not installed — forever, however many times it is installed.
 * That is the whole of the "keeps trying to install tools that are already
 * there" symptom.
 */
export function lookupCommand(binary: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `where ${binary}` : `which ${binary}`;
}

/**
 * Does spawning this command need a shell?
 *
 * On Windows the things we spawn are not executables: `npm` is `npm.cmd`,
 * `codegraph` is a `.cmd`/`.ps1` shim. Node 20 and later refuse to execute a
 * `.cmd` without a shell (CVE-2024-27980 hardening), so an unshelled
 * `spawnSync('npm', ...)` fails with ENOENT on a machine where npm works fine
 * in every terminal.
 *
 * `shell: true` on Windows means the arguments are concatenated rather than
 * escaped (Node's DEP0190), so callers must pass values they control — package
 * names and fixed flags — never user input.
 */
export function needsShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * Quote one argument for the Windows shell.
 *
 * `shell: true` concatenates arguments instead of escaping them (Node
 * DEP0190), so a path with a space — which on Windows is most of them —
 * arrives as two arguments. Quoting is therefore part of using a shell at all,
 * not an optional hardening step.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') {
    return '""';
  }
  // Quote anything that is not plainly inert. Whitespace is the obvious case,
  // but `cmd.exe` also acts on & | < > ^ ( ) — a JavaScript snippet or a glob
  // reaches the child mangled, or not at all, without quotes.
  return /^[A-Za-z0-9_.:\\/=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Spawn a tool the extension installed, on any platform.
 *
 * Every tool this extension installs arrives on Windows as a `.cmd` or `.ps1`
 * shim (`npm`, `codegraph`), and Node 20+ will not execute those without a
 * shell. Each call site that spawns one has to make the same decision, which
 * is exactly the kind of rule that gets fixed in one place and left wrong in
 * the other four — so it lives here and the call sites ask.
 *
 * `execSync` callers do not need this: it always runs through a shell.
 */
export function runTool(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
): SpawnSyncReturns<string> {
  const shell = needsShell();
  if (!shell) {
    return spawnSync(command, args, { ...options, shell });
  }
  // The command needs quoting as much as the arguments do: with a shell, an
  // absolute path such as C:\Program Files\nodejs\node.exe is split at the
  // space and cmd reports `'C:\Program' is not recognized`.
  return spawnSync(quoteWindowsArg(command), args.map(quoteWindowsArg), { ...options, shell });
}

/**
 * Is a POSIX shell available to run `curl … | sh` style installers?
 *
 * A stock Windows box has no `sh`, so the shell-script fallback cannot run
 * there at all — it is not a matter of quoting. Callers should offer a
 * platform-native path instead of reporting a failure the user cannot fix.
 */
export function canRunShellScript(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
