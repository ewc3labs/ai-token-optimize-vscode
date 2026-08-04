import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TOOLS_TO_INSTALL, ToolInstallEntry } from '../constants';
import {
  IS_WINDOWS,
  combinedOutput,
  describeTool,
  invalidateToolCache,
  isBinaryAvailable,
  knownInstallDirs,
  managedBinDir,
  ranOk,
  resolveTool,
  runTool,
} from './toolResolver';

export interface InstallResult {
  packageName: string;
  installed: boolean;
  alreadyInstalled: boolean;
  error?: string;
}

// Detection lives in toolResolver: it scans PATH natively (no `which`, which
// does not exist on Windows) and then well-known install dirs, so a tool the
// user installed by hand is picked up even when VS Code's inherited PATH is
// stale. Re-exported here because most call sites import it from this module.
export { isBinaryAvailable };

/**
 * Called on workspace open.
 * 1. Generates .cavemanrc config file
 * 2. Logs availability of real tools (rg, git, jq)
 * 3. For each entry in TOOLS_TO_INSTALL, installs if missing (with user consent)
 */
export async function installAllTools(outputChannel: vscode.OutputChannel): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    outputChannel.appendLine('[installer] No workspace folder — skipping tool setup');
    return results;
  }

  const wsPath = workspaceFolders[0].uri.fsPath;
  generateCavemanConfig(wsPath, outputChannel);
  // Re-probe on every run: a tool may have been installed manually since the
  // last activation, and cached "missing" answers would re-prompt for install.
  invalidateToolCache();
  logToolAvailability(outputChannel);

  for (const tool of TOOLS_TO_INSTALL) {
    const resolved = resolveTool(tool.name);
    if (resolved) {
      results.push({ packageName: tool.name, installed: false, alreadyInstalled: true });
      outputChannel.appendLine(`[installer] ✓ ${tool.name} already installed → ${describeTool(tool.name)}`);
      if (resolved.source === 'known-dir') {
        await offerPathHint(tool.name, resolved.dir, outputChannel);
      }
      continue;
    }

    outputChannel.appendLine(`[installer] ○ ${tool.name} not found — offering install`);
    const choice = await vscode.window.showInformationMessage(
      `AI Token Optimizer: ${tool.name} not found.\n${tool.description}`,
      'Install Now',
      'Later'
    );
    if (choice === 'Install Now') {
      const result = await installTool(tool, outputChannel);
      results.push(result);
      if (result.installed && tool.name === 'codegraph') {
        await offerWireCodegraphAgents(outputChannel);
      }
    } else {
      results.push({ packageName: tool.name, installed: false, alreadyInstalled: false, error: 'User deferred' });
    }
  }

  return results;
}

async function installTool(tool: ToolInstallEntry, outputChannel: vscode.OutputChannel): Promise<InstallResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing ${tool.name}…`, cancellable: false },
    async () => {
      try {
        let result: InstallResult;
        if (tool.method === 'npm-global' && tool.npmPackage) {
          result = installViaNpm(tool.name, tool.npmPackage, outputChannel);
        } else if (tool.method === 'brew' || tool.method === 'shell-script') {
          result = IS_WINDOWS
            ? installOnWindows(tool, outputChannel)
            : installViaBrewOrShell(tool, outputChannel);
        } else {
          throw new Error(`Unknown install method: ${tool.method}`);
        }
        // The new binary usually lands outside the inherited PATH — drop the
        // cached "missing" answer so it resolves for post-install and MCP wiring.
        invalidateToolCache();
        if (result.installed) {
          outputChannel.appendLine(`[installer] ${tool.name} resolves to: ${describeTool(tool.name)}`);
        }
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[installer] ✗ ${tool.name} install error: ${msg}`);
        return { packageName: tool.name, installed: false, alreadyInstalled: false, error: msg };
      }
    }
  );
}

function installViaNpm(binaryName: string, npmPackage: string, outputChannel: vscode.OutputChannel): InstallResult {
  if (!isBinaryAvailable('npm')) {
    const msg = 'npm not found — install Node.js (https://nodejs.org) and reload VS Code';
    outputChannel.appendLine(`[installer] ✗ ${binaryName}: ${msg}`);
    vscode.window.showErrorMessage(`Cannot install ${binaryName}: ${msg}`);
    return { packageName: binaryName, installed: false, alreadyInstalled: false, error: msg };
  }

  outputChannel.appendLine(`[installer] Running: npm install -g ${npmPackage}`);
  // runTool, not spawnSync('npm', …): on Windows npm is npm.cmd and Node
  // refuses to spawn a .cmd without a shell.
  const result = runTool('npm', ['install', '-g', npmPackage], { timeoutMs: 180_000 });
  if (ranOk(result)) {
    outputChannel.appendLine(`[installer] ✓ ${binaryName} installed`);
    vscode.window.showInformationMessage(`${binaryName} installed successfully.`);
    return { packageName: binaryName, installed: true, alreadyInstalled: false };
  }
  const errMsg = result.stderr?.trim() || result.error?.message || 'npm install failed';
  outputChannel.appendLine(`[installer] ✗ ${binaryName}: ${errMsg}`);
  vscode.window.showErrorMessage(`Failed to install ${binaryName}. Try: npm install -g ${npmPackage}`);
  return { packageName: binaryName, installed: false, alreadyInstalled: false, error: errMsg };
}

function installViaBrewOrShell(tool: ToolInstallEntry, outputChannel: vscode.OutputChannel): InstallResult {
  const isMac = os.platform() === 'darwin';
  const hasBrewPkg = tool.brewPackage && isMac && isBinaryAvailable('brew');

  if (hasBrewPkg && tool.brewPackage) {
    outputChannel.appendLine(`[installer] Running: brew install ${tool.brewPackage}`);
    const result = runTool('brew', ['install', tool.brewPackage], { timeoutMs: 120_000 });
    if (ranOk(result)) {
      outputChannel.appendLine(`[installer] ✓ ${tool.name} installed via brew`);
      runPostInstall(tool, outputChannel);
      return { packageName: tool.name, installed: true, alreadyInstalled: false };
    }
    const brewErr = result.stderr?.trim() || result.error?.message || 'brew install failed';
    outputChannel.appendLine(`[installer] brew failed, trying shell script: ${brewErr}`);
  }

  // Fall back to shell script
  if (tool.shellScriptUrl) {
    outputChannel.appendLine(`[installer] Running: curl -fsSL ${tool.shellScriptUrl} | sh`);
    const result = runTool('sh', ['-c', `curl -fsSL ${tool.shellScriptUrl} | sh`], { timeoutMs: 120_000 });
    if (ranOk(result)) {
      outputChannel.appendLine(`[installer] ✓ ${tool.name} installed via shell script`);
      runPostInstall(tool, outputChannel);
      return { packageName: tool.name, installed: true, alreadyInstalled: false };
    }
    const shellErr = result.stderr?.trim() || result.error?.message || 'shell install failed';
    outputChannel.appendLine(`[installer] ✗ ${tool.name}: ${shellErr}`);
    const installHint = isMac
      ? `brew install ${tool.brewPackage || tool.name}`
      : `curl -fsSL ${tool.shellScriptUrl} | sh`;
    vscode.window.showErrorMessage(`Failed to install ${tool.name}. Try manually: ${installHint}`);
    return { packageName: tool.name, installed: false, alreadyInstalled: false, error: shellErr };
  }

  const err = `No valid install method for ${tool.name} on ${os.platform()}`;
  outputChannel.appendLine(`[installer] ✗ ${err}`);
  return { packageName: tool.name, installed: false, alreadyInstalled: false, error: err };
}

/**
 * Windows install path: download the published release archive with PowerShell
 * (present on every supported Windows) and unpack it into the managed bin dir,
 * which toolResolver probes directly — so the tool works immediately, without
 * requiring a PATH change or a machine restart.
 */
function installOnWindows(tool: ToolInstallEntry, outputChannel: vscode.OutputChannel): InstallResult {
  const download = tool.windowsDownload;
  if (!download) {
    const err = `${tool.name} has no Windows install method configured`;
    outputChannel.appendLine(`[installer] ✗ ${err}`);
    vscode.window.showErrorMessage(
      `${tool.name} cannot be installed automatically on Windows. Install it manually, then set "aiTokenOptimizer.toolPaths".`
    );
    return { packageName: tool.name, installed: false, alreadyInstalled: false, error: err };
  }

  const destDir = managedBinDir();
  outputChannel.appendLine(`[installer] Downloading ${download.zipUrl}`);
  outputChannel.appendLine(`[installer] Destination: ${destDir}`);

  const result = runPowerShell(downloadAndUnzipScript(download.zipUrl, destDir, download.exeName), 300_000);
  const exePath = path.join(destDir, download.exeName);

  if (!ranOk(result) || !fs.existsSync(exePath)) {
    const err = combinedOutput(result).trim().split('\n').slice(-3).join(' ')
      || result.error?.message
      || 'PowerShell download failed';
    outputChannel.appendLine(`[installer] ✗ ${tool.name}: ${err}`);
    vscode.window.showErrorMessage(
      `Failed to install ${tool.name} on Windows. Download ${download.zipUrl} manually, extract ${download.exeName}, and set "aiTokenOptimizer.toolPaths".`
    );
    return { packageName: tool.name, installed: false, alreadyInstalled: false, error: err };
  }

  outputChannel.appendLine(`[installer] ✓ ${tool.name} installed → ${exePath}`);
  invalidateToolCache(tool.name);
  runPostInstall(tool, outputChannel);
  void offerPathHint(tool.name, destDir, outputChannel);
  return { packageName: tool.name, installed: true, alreadyInstalled: false };
}

/**
 * Downloads a zip, unpacks it, and flattens any single top-level folder so the
 * executable ends up directly in `destDir`. `-ErrorAction Stop` + non-zero exit
 * on failure keeps the result observable from Node.
 */
function downloadAndUnzipScript(zipUrl: string, destDir: string, exeName: string): string {
  const ps = (value: string) => value.replace(/'/g, "''");
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $dest = '${ps(destDir)}'`,
    '  New-Item -ItemType Directory -Force -Path $dest | Out-Null',
    '  $zip = Join-Path $env:TEMP ("ai-token-optimizer-" + [guid]::NewGuid().ToString() + ".zip")',
    '  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '  $ProgressPreference = "SilentlyContinue"',
    `  Invoke-WebRequest -UseBasicParsing -Uri '${ps(zipUrl)}' -OutFile $zip`,
    '  $staging = Join-Path $env:TEMP ("ai-token-optimizer-x-" + [guid]::NewGuid().ToString())',
    '  Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force',
    `  $exe = Get-ChildItem -Path $staging -Recurse -Filter '${ps(exeName)}' | Select-Object -First 1`,
    `  if (-not $exe) { throw '${ps(exeName)} not found in archive' }`,
    '  Copy-Item -LiteralPath $exe.FullName -Destination $dest -Force',
    '  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue',
    '  exit 0',
    '} catch { Write-Error $_.Exception.Message; exit 1 }',
  ].join('; ');
}

function runPowerShell(script: string, timeoutMs: number) {
  const shell = isBinaryAvailable('pwsh') ? 'pwsh' : 'powershell';
  return runTool(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeoutMs,
  });
}

/**
 * A tool that resolves only via a known install dir works inside the extension
 * but not in the user's terminal or in agent hooks (RTK's Copilot hook shells
 * out to a bare `rtk`). Offer a persistent, user-scoped PATH entry — never
 * applied without consent, since it edits the user's environment.
 */
const pathHintShown = new Set<string>();

async function offerPathHint(toolName: string, dir: string, outputChannel: vscode.OutputChannel): Promise<void> {
  if (isOnPath(dir)) { return; }
  outputChannel.appendLine(`[installer] ⚠ ${dir} is not on PATH — ${toolName} works in this extension but not in your terminal`);

  // Only Windows gets an automatic fix, and only once per window: activation
  // runs on every workspace open and a repeated modal would be nagging.
  if (!IS_WINDOWS || pathHintShown.has(toolName)) { return; }
  pathHintShown.add(toolName);

  const choice = await vscode.window.showWarningMessage(
    `${toolName} is installed at ${dir}, which is not on your PATH. Terminal commands and agent hooks won't find it.`,
    'Add to PATH',
    'Not Now'
  );
  if (choice !== 'Add to PATH') { return; }

  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  $current = [Environment]::GetEnvironmentVariable("Path", "User")',
    `  $dir = '${dir.replace(/'/g, "''")}'`,
    '  if ($current -split ";" -notcontains $dir) {',
    '    $next = if ([string]::IsNullOrEmpty($current)) { $dir } else { $current.TrimEnd(";") + ";" + $dir }',
    '    [Environment]::SetEnvironmentVariable("Path", $next, "User")',
    '  }',
    '  exit 0',
    '} catch { Write-Error $_.Exception.Message; exit 1 }',
  ].join('; ');

  const result = runPowerShell(script, 30_000);
  if (ranOk(result)) {
    outputChannel.appendLine(`[installer] ✓ Added ${dir} to user PATH (new terminals only)`);
    vscode.window.showInformationMessage(
      `Added ${dir} to your user PATH. Restart VS Code for terminals and agent hooks to pick it up.`,
      'Restart Now'
    ).then(c => {
      if (c === 'Restart Now') { vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    });
  } else {
    outputChannel.appendLine(`[installer] ⚠ Could not update PATH: ${combinedOutput(result).trim() || result.error?.message}`);
    vscode.window.showWarningMessage(`Could not update PATH automatically. Add this folder manually: ${dir}`);
  }
}

function isOnPath(dir: string): boolean {
  const entries = (process.env.PATH || process.env.Path || '').split(path.delimiter);
  const norm = (p: string) => {
    const trimmed = path.resolve(p.trim().replace(/^"(.*)"$/, '$1'));
    return IS_WINDOWS ? trimmed.toLowerCase().replace(/[\\/]+$/, '') : trimmed.replace(/\/+$/, '');
  };
  const target = norm(dir);
  return entries.filter(Boolean).some(entry => {
    try { return norm(entry) === target; } catch { return false; }
  });
}

/**
 * Run post-install setup (e.g. `rtk init -g --copilot` to wire VS Code Copilot hook).
 */
function runPostInstall(tool: ToolInstallEntry, outputChannel: vscode.OutputChannel): void {
  if (!tool.postInstallArgs || tool.postInstallArgs.length === 0) { return; }
  invalidateToolCache(tool.name);
  outputChannel.appendLine(`[installer] Post-install: ${tool.name} ${tool.postInstallArgs.join(' ')}`);
  const result = runTool(tool.name, tool.postInstallArgs, { timeoutMs: 30_000 });
  if (ranOk(result)) {
    outputChannel.appendLine(`[installer] ✓ ${tool.name} post-install complete`);
    if (tool.name === 'rtk') {
      vscode.window.showInformationMessage(
        'RTK installed and wired to VS Code Copilot. Restart VS Code to activate command interception.',
        'Restart Now'
      ).then(choice => {
        if (choice === 'Restart Now') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    }
  } else {
    outputChannel.appendLine(`[installer] ⚠ Post-install failed: ${combinedOutput(result).trim() || result.error?.message || 'unknown error'}`);
  }
}

/**
 * After codegraph is installed, offer `codegraph install --yes` to wire MCP
 * server config for Claude Code, Cursor, Codex CLI, etc.
 */
async function offerWireCodegraphAgents(outputChannel: vscode.OutputChannel): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'CodeGraph installed! Wire it to your AI agents (Claude Code, Cursor, Codex…)?',
    'Wire Agents',
    'Skip'
  );
  if (choice === 'Wire Agents') {
    outputChannel.appendLine('[installer] Running: codegraph install --yes');
    const result = runTool('codegraph', ['install', '--yes'], { timeoutMs: 60_000 });
    if (ranOk(result)) {
      outputChannel.appendLine('[installer] ✓ CodeGraph agent wiring complete');
      vscode.window.showInformationMessage('CodeGraph wired. Restart your agents to activate.');
    } else {
      outputChannel.appendLine(`[installer] ⚠ Agent wiring failed (run "codegraph install" manually): ${combinedOutput(result).trim() || result.error?.message}`);
    }
  }
}

function generateCavemanConfig(wsPath: string, outputChannel: vscode.OutputChannel): void {
  const cavemanrcPath = path.join(wsPath, '.cavemanrc');
  if (!fs.existsSync(cavemanrcPath)) {
    const verbosityLevel = vscode.workspace.getConfiguration('aiTokenOptimizer').get('verbosityLevel', 'full');
    fs.writeFileSync(cavemanrcPath, JSON.stringify({
      mode: verbosityLevel,
      rules: { skipIntroductions: true, skipConclusions: true, compactCodeBlocks: true, bulletOverParagraph: true },
    }, null, 2), 'utf-8');
    outputChannel.appendLine('[installer] Created .cavemanrc (verbosity config)');
  }
}

/**
 * "Why can't the extension see my install?" report. Shows the resolution result
 * for every tool plus the exact directories that were searched — the fastest
 * way to diagnose a Windows machine where a tool is installed but invisible.
 */
export function reportToolDiagnostics(outputChannel: vscode.OutputChannel): void {
  invalidateToolCache();
  outputChannel.show(true);
  outputChannel.appendLine('');
  outputChannel.appendLine('══════════════════════════════════════════════════════════');
  outputChannel.appendLine('  AI Token Optimizer — Tool Detection Diagnostics');
  outputChannel.appendLine(`  ${process.platform} ${process.arch}  |  Node ${process.versions.node}`);
  outputChannel.appendLine('══════════════════════════════════════════════════════════');

  for (const bin of ['codegraph', 'rtk', 'node', 'npm', 'npx', 'git', 'sqlite3', 'rg', 'jq']) {
    const resolved = resolveTool(bin);
    outputChannel.appendLine(`  ${resolved ? '✓' : '✗'} ${bin.padEnd(10)} ${describeTool(bin)}`);
    if (resolved) {
      const version = runTool(bin, ['--version'], { timeoutMs: 5000 });
      const first = (version.stdout ?? '').trim().split('\n')[0];
      if (first) { outputChannel.appendLine(`      version: ${first}`); }
      outputChannel.appendLine(`      launch : ${resolved.needsShell ? `cmd /c "${resolved.path}"` : resolved.path}`);
    }
  }

  outputChannel.appendLine('');
  outputChannel.appendLine('  PATH entries searched:');
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    outputChannel.appendLine(`    ${dir}`);
  }
  outputChannel.appendLine('');
  outputChannel.appendLine('  Known install directories searched (used when PATH misses them):');
  for (const dir of knownInstallDirs()) {
    outputChannel.appendLine(`    ${fs.existsSync(dir) ? '•' : '·'} ${dir}${fs.existsSync(dir) ? '' : '  (does not exist)'}`);
  }
  outputChannel.appendLine('');
  outputChannel.appendLine('  Still not detected? Set an explicit path, e.g.:');
  outputChannel.appendLine(IS_WINDOWS
    ? '    "aiTokenOptimizer.toolPaths": { "codegraph": "C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\npm\\\\codegraph.cmd" }'
    : '    "aiTokenOptimizer.toolPaths": { "codegraph": "/usr/local/bin/codegraph" }');
  outputChannel.appendLine('══════════════════════════════════════════════════════════');
}

function logToolAvailability(outputChannel: vscode.OutputChannel): void {
  const tools = [
    { bin: 'rtk',       label: 'rtk',        desc: IS_WINDOWS ? 'CLI output compression proxy (auto-downloaded from GitHub releases)' : 'CLI output compression proxy (brew install rtk)' },
    { bin: 'codegraph', label: 'codegraph',   desc: 'semantic code indexing (npm i -g @colbymchenry/codegraph)' },
    { bin: 'rg',        label: 'ripgrep',     desc: 'fast code search' },
    { bin: 'git',       label: 'git',         desc: 'version control' },
    { bin: 'jq',        label: 'jq',          desc: 'JSON compression' },
  ];
  outputChannel.appendLine(`[installer] Tool availability (platform: ${process.platform}):`);
  for (const t of tools) {
    const resolved = resolveTool(t.bin);
    outputChannel.appendLine(
      `  ${resolved ? '✓' : '○'} ${t.label.padEnd(12)} — ${resolved ? describeTool(t.bin) : `not found (${t.desc})`}`
    );
  }
}
