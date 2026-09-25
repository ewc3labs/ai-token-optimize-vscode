import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { getConfig, getEffectiveStrategies } from '../config';
import { isBinaryAvailable } from '../installer/installer';
import { getProjectsToIndex } from '../ui/projectPicker';
import { COPILOT_INSTRUCTIONS_PATH, CLAUDE_INSTRUCTIONS_PATH, CODEX_INSTRUCTIONS_PATH, MARKER_START, MCP_CACHE_SERVER_NAME } from '../constants';
import { SemanticCacheStore, CACHE_DIR, CACHE_FILE } from '../cache/store';
import { runTool } from '../installer/platform';

// ─── result types ────────────────────────────────────────────────────────────

type Status = 'ok' | 'warn' | 'error' | 'disabled';

interface CategoryResult {
  category: string;
  cap: string;
  status: Status;
  lines: string[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function runCmd(cmd: string, args: string[], cwd?: string): string {
  // The tools validated here (codegraph, rtk) are .cmd shims on Windows.
  const r = runTool(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    encoding: 'utf-8',
    cwd,
  });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

function getVersion(bin: string): string {
  try {
    const out = execSync(`${bin} --version`, { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' });
    return out.trim().split('\n')[0];
  } catch {
    return 'unknown';
  }
}

function wsPath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function instructionPath(rel: string): string {
  const ws = wsPath();
  return ws ? path.join(ws, rel) : '';
}

function checkInstructionFile(rel: string, keyword: string): { exists: boolean; hasSection: boolean; path: string } {
  const p = instructionPath(rel);
  if (!p || !fs.existsSync(p)) { return { exists: false, hasSection: false, path: p }; }
  const content = fs.readFileSync(p, 'utf-8');
  const hasSection = content.includes(MARKER_START) && content.includes(keyword);
  return { exists: true, hasSection, path: p };
}

function icon(status: Status): string {
  return { ok: '✓', warn: '⚠', error: '✗', disabled: '○' }[status];
}

// ─── CAP-1: CodeGraph ────────────────────────────────────────────────────────

async function validateCodeGraph(): Promise<CategoryResult> {
  const config = getConfig();
  const strategies = getEffectiveStrategies(config);
  const lines: string[] = [];
  let status: Status = 'ok';

  if (!strategies.codeGraph) {
    return { category: 'CodeGraph', cap: 'CAP-1', status: 'disabled', lines: ['Strategy disabled in current profile'] };
  }

  const installed = isBinaryAvailable('codegraph');
  if (!installed) {
    return {
      category: 'CodeGraph', cap: 'CAP-1', status: 'error',
      lines: [
        'codegraph binary not found on PATH',
        'Install: npm install -g @colbymchenry/codegraph',
        'Then run "AI Token Optimizer: Install Tools" or: codegraph install --yes',
      ],
    };
  }

  const version = getVersion('codegraph');
  lines.push(`Binary     : codegraph ${version}`);

  const projects = getProjectsToIndex();
  if (projects.length === 0) {
    lines.push('Projects   : none configured — all workspace folders used as fallback');
    status = 'warn';
  } else {
    lines.push(`Projects   : ${projects.length} configured`);
  }

  let allIndexed = true;
  for (const project of projects) {
    const indexDir = path.join(project.absPath, '.codegraph');
    const hasIndex = fs.existsSync(indexDir);
    if (!hasIndex) {
      allIndexed = false;
      lines.push(`  ✗ ${project.name}: not indexed — run "codegraph init" in ${project.absPath}`);
      status = 'warn';
    } else {
      // codegraph status for node/edge count
      const statusOut = runCmd('codegraph', ['status'], project.absPath);
      const nodeLine = statusOut.split('\n').find(l => /nodes|symbols/i.test(l))?.trim();
      lines.push(`  ✓ ${project.name}: indexed${nodeLine ? ` — ${nodeLine}` : ''}`);
    }
  }

  // Check workspace root if no projects configured
  if (projects.length === 0) {
    const ws = wsPath();
    if (ws) {
      const rootIndex = path.join(ws, '.codegraph');
      if (fs.existsSync(rootIndex)) {
        const statusOut = runCmd('codegraph', ['status'], ws);
        const nodeLine = statusOut.split('\n').find(l => /nodes|symbols/i.test(l))?.trim();
        lines.push(`  ✓ workspace root: indexed${nodeLine ? ` — ${nodeLine}` : ''}`);
        allIndexed = true;
      } else {
        lines.push('  ○ workspace root: no .codegraph/ — run "codegraph init"');
        allIndexed = false;
        status = 'warn';
      }
    }
  }

  if (allIndexed && projects.length > 0) {
    lines.push('Index status: all projects indexed ✓');
  }

  return { category: 'CodeGraph', cap: 'CAP-1', status, lines };
}

// ─── CAP-2: RTK ──────────────────────────────────────────────────────────────

async function validateRtk(): Promise<CategoryResult> {
  const config = getConfig();
  const strategies = getEffectiveStrategies(config);
  const lines: string[] = [];

  if (!strategies.outputCompression) {
    return { category: 'RTK Output Compression', cap: 'CAP-2', status: 'disabled', lines: ['Strategy disabled in current profile'] };
  }

  const installed = isBinaryAvailable('rtk');
  if (!installed) {
    return {
      category: 'RTK Output Compression', cap: 'CAP-2', status: 'error',
      lines: [
        'rtk binary not found on PATH',
        'Install: brew install rtk   (macOS)',
        '         curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh',
        'Then run "AI Token Optimizer: Install Tools" to wire the VS Code Copilot hook',
      ],
    };
  }

  const version = getVersion('rtk');
  lines.push(`Binary     : rtk ${version}`);

  // Check if hook is wired for VS Code Copilot
  const showOut = runCmd('rtk', ['init', '--show']);
  const hookLine = showOut.split('\n').find(l => /hook|copilot|claude|wired|active|install/i.test(l))?.trim();
  if (hookLine) {
    lines.push(`Hook status: ${hookLine}`);
  } else {
    lines.push('Hook status: run "rtk init --show" to check agent wiring');
  }

  // Savings stats from rtk gain
  const gainOut = runCmd('rtk', ['gain']);
  const statLines = gainOut.split('\n')
    .filter(l => /token|saved|%|session|total/i.test(l))
    .slice(0, 4)
    .map(l => `  ${l.trim()}`);
  if (statLines.length > 0) {
    lines.push('Savings stats:');
    lines.push(...statLines);
  } else {
    lines.push('Savings stats: no sessions recorded yet (run some dev commands through RTK)');
  }

  return { category: 'RTK Output Compression', cap: 'CAP-2', status: 'ok', lines };
}

// ─── CAP-3: Verbosity Control ────────────────────────────────────────────────

async function validateVerbosity(): Promise<CategoryResult> {
  const config = getConfig();
  const strategies = getEffectiveStrategies(config);
  const lines: string[] = [];
  let status: Status = 'ok';

  if (!strategies.verbosityControl) {
    return { category: 'Verbosity Control', cap: 'CAP-3', status: 'disabled', lines: ['Strategy disabled in current profile'] };
  }

  lines.push(`Verbosity level: ${config.verbosityLevel} (${config.verbosityLevel === 'full' ? '~35%' : config.verbosityLevel === 'light' ? '~20%' : '~50%'} token reduction target)`);

  const checks = [
    { rel: COPILOT_INSTRUCTIONS_PATH, label: 'Copilot', keyword: 'CAP-3' },
    { rel: CLAUDE_INSTRUCTIONS_PATH,  label: 'Claude',  keyword: 'CAP-3' },
    { rel: CODEX_INSTRUCTIONS_PATH,   label: 'Codex',   keyword: 'CAP-3' },
  ];

  let anyFile = false;
  for (const { rel, label, keyword } of checks) {
    if (!config.targetTools.includes(label.toLowerCase() as any) &&
        !['copilot'].includes(label.toLowerCase())) {
      // always show copilot, show others only if in target tools
    }
    const { exists, hasSection, path: p } = checkInstructionFile(rel, keyword);
    if (!exists) {
      lines.push(`  ○ ${label.padEnd(8)}: ${p || rel} not found — run Regenerate`);
      status = 'warn';
    } else if (!hasSection) {
      lines.push(`  ⚠ ${label.padEnd(8)}: file exists but CAP-3 section missing — run Regenerate`);
      status = 'warn';
    } else {
      lines.push(`  ✓ ${label.padEnd(8)}: verbosity rules injected`);
      anyFile = true;
    }
  }

  if (!anyFile) {
    status = 'error';
  }

  return { category: 'Verbosity Control', cap: 'CAP-3', status, lines };
}

// ─── CAP-4: Session Management ───────────────────────────────────────────────

async function validateSession(): Promise<CategoryResult> {
  const config = getConfig();
  const strategies = getEffectiveStrategies(config);
  const lines: string[] = [];
  let status: Status = 'ok';

  if (!strategies.sessionManagement) {
    return { category: 'Session Management', cap: 'CAP-4', status: 'disabled', lines: ['Strategy disabled in current profile'] };
  }

  const checks = [
    { rel: COPILOT_INSTRUCTIONS_PATH, label: 'Copilot', keyword: 'CAP-4' },
    { rel: CLAUDE_INSTRUCTIONS_PATH,  label: 'Claude',  keyword: 'CAP-4' },
    { rel: CODEX_INSTRUCTIONS_PATH,   label: 'Codex',   keyword: 'CAP-4' },
  ];

  let anyFile = false;
  for (const { rel, label, keyword } of checks) {
    const { exists, hasSection, path: p } = checkInstructionFile(rel, keyword);
    if (!exists) {
      lines.push(`  ○ ${label.padEnd(8)}: ${p || rel} not found — run Regenerate`);
      status = 'warn';
    } else if (!hasSection) {
      lines.push(`  ⚠ ${label.padEnd(8)}: file exists but CAP-4 section missing — run Regenerate`);
      status = 'warn';
    } else {
      lines.push(`  ✓ ${label.padEnd(8)}: session management rules injected`);
      anyFile = true;
    }
  }

  if (!anyFile) {
    status = 'error';
  }

  // For Claude: check for /compact, /clear, /model mentions
  const claudeCheck = checkInstructionFile(CLAUDE_INSTRUCTIONS_PATH, '/compact');
  if (claudeCheck.exists && claudeCheck.hasSection) {
    lines.push('  ✓ Claude   : /compact, /clear, /model, /context commands documented');
  }

  return { category: 'Session Management', cap: 'CAP-4', status, lines };
}

// ─── CAP-5: Semantic Cache ───────────────────────────────────────────────────

async function validateSemanticCache(): Promise<CategoryResult> {
  const config = getConfig();
  const strategies = getEffectiveStrategies(config);
  const lines: string[] = [];
  let status: Status = 'ok';

  if (!strategies.semanticCache) {
    return { category: 'Semantic Cache', cap: 'CAP-5', status: 'disabled', lines: ['Strategy disabled in current profile'] };
  }

  const ws = wsPath();
  if (!ws) {
    return { category: 'Semantic Cache', cap: 'CAP-5', status: 'warn', lines: ['No workspace folder open'] };
  }

  // MCP server entry with a real bundle path on disk
  const settingsPath = path.join(ws, '.vscode', 'settings.json');
  let serverLine = `  ✗ MCP entry "${MCP_CACHE_SERVER_NAME}" missing from .vscode/settings.json — run "Configure MCP Servers"`;
  let serverOk = false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const entry = settings?.mcp?.servers?.[MCP_CACHE_SERVER_NAME];
    if (entry?.args?.[0]) {
      if (fs.existsSync(entry.args[0])) {
        serverLine = `  ✓ MCP server  : ${MCP_CACHE_SERVER_NAME} → ${entry.args[0]}`;
        serverOk = true;
      } else {
        serverLine = `  ⚠ MCP server  : registered but bundle missing at ${entry.args[0]} — run "Configure MCP Servers"`;
      }
    }
  } catch { /* missing/unparseable settings — reported below */ }
  lines.push(serverLine);
  if (!serverOk) { status = 'warn'; }

  // Claude Code reads MCP servers from ~/.claude.json (projects[ws].mcpServers),
  // not .vscode/settings.json — a separate, easy-to-miss wiring check. A pass
  // here only means Copilot can see the tool, not that Claude Code can too.
  const claudeConfigPath = path.join(require('os').homedir(), '.claude.json');
  let claudeServerLine = `  ✗ MCP entry "${MCP_CACHE_SERVER_NAME}" missing from ~/.claude.json — run "Configure MCP Servers"`;
  let claudeServerOk = false;
  try {
    const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
    const entry = claudeConfig?.projects?.[ws]?.mcpServers?.[MCP_CACHE_SERVER_NAME];
    if (entry?.args?.[0]) {
      if (fs.existsSync(entry.args[0])) {
        claudeServerLine = `  ✓ Claude MCP  : ${MCP_CACHE_SERVER_NAME} → ${entry.args[0]}`;
        claudeServerOk = true;
      } else {
        claudeServerLine = `  ⚠ Claude MCP  : registered but bundle missing at ${entry.args[0]} — run "Configure MCP Servers"`;
      }
    }
  } catch { /* missing/unparseable ~/.claude.json — reported below */ }
  lines.push(claudeServerLine);
  if (!claudeServerOk) { status = 'warn'; }

  // Cache file state
  const cacheFilePath = path.join(ws, CACHE_DIR, CACHE_FILE);
  if (fs.existsSync(cacheFilePath)) {
    try {
      const stats = new SemanticCacheStore(ws).stats();
      lines.push(`  ✓ Cache file  : ${stats.entries} entries, ${stats.totalHits} hits, ~${stats.estTokensSaved} tokens served from cache`);
    } catch {
      lines.push(`  ⚠ Cache file  : ${cacheFilePath} unreadable — will be recreated on next store`);
    }
  } else {
    lines.push('  ○ Cache file  : empty — no queries cached yet');
  }

  // CAP-5 guidance present in instruction files
  const checks = [
    { rel: COPILOT_INSTRUCTIONS_PATH, label: 'Copilot' },
    { rel: CLAUDE_INSTRUCTIONS_PATH,  label: 'Claude'  },
    { rel: CODEX_INSTRUCTIONS_PATH,   label: 'Codex'   },
  ];
  for (const { rel, label } of checks) {
    const { exists, hasSection } = checkInstructionFile(rel, 'CAP-5');
    if (!exists) {
      lines.push(`  ○ ${label.padEnd(8)}: ${rel} not found — run Regenerate`);
      status = 'warn';
    } else if (!hasSection) {
      lines.push(`  ⚠ ${label.padEnd(8)}: file exists but CAP-5 section missing — run Regenerate`);
      status = 'warn';
    } else {
      lines.push(`  ✓ ${label.padEnd(8)}: semantic cache rules injected`);
    }
  }

  return { category: 'Semantic Cache', cap: 'CAP-5', status, lines };
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function validateAllStrategies(outputChannel: vscode.OutputChannel): Promise<void> {
  outputChannel.show(true);
  outputChannel.appendLine('');
  outputChannel.appendLine('══════════════════════════════════════════════════════════');
  outputChannel.appendLine('  AI Token Optimizer — Strategy Validation Report');
  outputChannel.appendLine(`  ${new Date().toLocaleString()}  |  Profile: ${getConfig().profile}`);
  outputChannel.appendLine('══════════════════════════════════════════════════════════');

  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Validating all strategies…', cancellable: false },
    async (progress) => {
      progress.report({ message: 'CAP-1: CodeGraph…' });
      const r1 = await validateCodeGraph();

      progress.report({ message: 'CAP-2: RTK…' });
      const r2 = await validateRtk();

      progress.report({ message: 'CAP-3: Verbosity…' });
      const r3 = await validateVerbosity();

      progress.report({ message: 'CAP-4: Session…' });
      const r4 = await validateSession();

      progress.report({ message: 'CAP-5: Semantic Cache…' });
      const r5 = await validateSemanticCache();

      return [r1, r2, r3, r4, r5];
    }
  );

  let allOk = true;

  for (const r of results) {
    outputChannel.appendLine('');
    outputChannel.appendLine(`  ${icon(r.status)} ${r.cap}: ${r.category}  [${r.status.toUpperCase()}]`);
    outputChannel.appendLine('  ──────────────────────────────────────────────────────');
    for (const line of r.lines) {
      outputChannel.appendLine(`  ${line}`);
    }
    if (r.status !== 'ok' && r.status !== 'disabled') {
      allOk = false;
    }
  }

  outputChannel.appendLine('');
  outputChannel.appendLine('══════════════════════════════════════════════════════════');

  // Summary banner
  const okCount = results.filter(r => r.status === 'ok').length;
  const disabledCount = results.filter(r => r.status === 'disabled').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  const warnCount = results.filter(r => r.status === 'warn').length;

  outputChannel.appendLine(`  Summary: ${okCount} ok  |  ${disabledCount} disabled  |  ${warnCount} warn  |  ${errorCount} error`);
  outputChannel.appendLine('══════════════════════════════════════════════════════════');

  // Actionable fixes
  const fixes: string[] = [];
  for (const r of results) {
    if (r.status === 'error' || r.status === 'warn') {
      if (r.cap === 'CAP-1' && !isBinaryAvailable('codegraph')) {
        fixes.push('Install CodeGraph: npm install -g @colbymchenry/codegraph');
      }
      if (r.cap === 'CAP-2' && !isBinaryAvailable('rtk')) {
        fixes.push('Install RTK: brew install rtk');
      }
      if ((r.cap === 'CAP-3' || r.cap === 'CAP-4' || r.cap === 'CAP-5') && r.lines.some(l => l.includes('not found') || l.includes('missing'))) {
        fixes.push('Regenerate instruction files: run "AI Token Optimizer: Regenerate Instruction Files"');
      }
      if (r.cap === 'CAP-5' && r.lines.some(l => l.includes('Configure MCP Servers'))) {
        fixes.push('Register the token-cache MCP server: run "AI Token Optimizer: Configure MCP Servers"');
      }
    }
  }

  if (fixes.length > 0) {
    outputChannel.appendLine('');
    outputChannel.appendLine('  Recommended actions:');
    for (const fix of [...new Set(fixes)]) {
      outputChannel.appendLine(`    → ${fix}`);
    }
    outputChannel.appendLine('');
  }

  // Notification with actions
  if (allOk && errorCount === 0 && warnCount === 0) {
    vscode.window.showInformationMessage(
      `AI Token Optimizer: All ${okCount} active strategies validated ✓`,
      'Show Report'
    ).then(c => { if (c) { outputChannel.show(); } });
  } else {
    const actions: string[] = ['Show Report'];
    if (!isBinaryAvailable('codegraph') || !isBinaryAvailable('rtk')) {
      actions.unshift('Install Tools');
    }
    if (results.some(r => (r.status === 'warn' || r.status === 'error') && (r.cap === 'CAP-3' || r.cap === 'CAP-4' || r.cap === 'CAP-5'))) {
      actions.unshift('Regenerate');
    }
    const choice = await vscode.window.showWarningMessage(
      `AI Token Optimizer: ${errorCount} error(s), ${warnCount} warning(s) — check Output panel`,
      ...actions
    );
    if (choice === 'Show Report') { outputChannel.show(); }
    if (choice === 'Install Tools') { vscode.commands.executeCommand('aiTokenOptimizer.installTools'); }
    if (choice === 'Regenerate') { vscode.commands.executeCommand('aiTokenOptimizer.regenerateInstructions'); }
  }
}
