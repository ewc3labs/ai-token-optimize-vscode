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
 * Is a POSIX shell available to run `curl … | sh` style installers?
 *
 * A stock Windows box has no `sh`, so the shell-script fallback cannot run
 * there at all — it is not a matter of quoting. Callers should offer a
 * platform-native path instead of reporting a failure the user cannot fix.
 */
export function canRunShellScript(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
