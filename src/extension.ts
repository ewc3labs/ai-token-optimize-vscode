import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { hasAuthoredContent } from './generators/merge';
import {
  COPILOT_INSTRUCTIONS_PATH,
  CLAUDE_INSTRUCTIONS_PATH,
  CODEX_INSTRUCTIONS_PATH,
} from './constants';
import { showProjectPicker } from './ui/projectPicker';
import { generateAllInstructions } from './generators';
import { installAllTools } from './installer';
import { configureMcpServers } from './mcp';
import { createStatusBar, updateStatusBar, disposeStatusBar } from './ui/statusBar';
import { showProfilePicker } from './ui/quickPick';
import { DashboardPanel } from './ui/dashboard';
import { exportTelemetryCommand } from './ui/exportTelemetry';
import { startCodeGraphWatcher, runCodeGraphReindex, validateIndex, disposeCodeGraphWatcher, validateAllStrategies } from './strategies';
import { SemanticCacheStore } from './cache/store';
import { CallLogStore } from './cache/callLog';
import { startSession } from './session/tracker';

let outputChannel: vscode.OutputChannel;
let extensionPath: string;
let sessionStarted = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('AI Token Optimizer');
  outputChannel.appendLine('[activate] AI Token Optimizer starting...');
  extensionPath = context.extensionPath;

  const config = getConfig();

  if (!config.enabled) {
    outputChannel.appendLine('[activate] Extension disabled via settings');
    return;
  }

  initSessionTracking();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aiTokenOptimizer.toggleAll', toggleAllCommand),
    vscode.commands.registerCommand('aiTokenOptimizer.selectProfile', showProfilePicker),
    vscode.commands.registerCommand('aiTokenOptimizer.regenerateInstructions', regenerateCommand),
    vscode.commands.registerCommand('aiTokenOptimizer.showDashboard', () => DashboardPanel.show(context.extensionUri)),
    vscode.commands.registerCommand('aiTokenOptimizer.reindex', () => runCodeGraphReindex(outputChannel)),
    vscode.commands.registerCommand('aiTokenOptimizer.validateIndex', () => validateIndex(outputChannel)),
    vscode.commands.registerCommand('aiTokenOptimizer.installTools', () => installAllTools(outputChannel)),
    vscode.commands.registerCommand('aiTokenOptimizer.manageProjects', () => showProjectPicker(outputChannel)),
    vscode.commands.registerCommand('aiTokenOptimizer.configureMcp', () => configureMcpServers(outputChannel, extensionPath)),
    vscode.commands.registerCommand('aiTokenOptimizer.validateAll', () => validateAllStrategies(outputChannel)),
    vscode.commands.registerCommand('aiTokenOptimizer.clearCache', clearCacheCommand),
    vscode.commands.registerCommand('aiTokenOptimizer.exportTelemetry', () => exportTelemetryCommand(outputChannel)),
  );

  // Create status bar
  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiTokenOptimizer')) {
        updateStatusBar();
        onConfigChanged();
      }
    })
  );

  // Auto-apply on activation
  if (config.autoApply) {
    await autoApply(config);
  }

  // Start CodeGraph file watcher
  if (config.activeStrategies.codeGraph) {
    const watchers = startCodeGraphWatcher(outputChannel);
    context.subscriptions.push(...watchers);
  }

  outputChannel.appendLine('[activate] AI Token Optimizer ready');
}

// Starts once per window — elapsed-session stats track from here, not from
// a persisted log. Guarded so toggling the extension off/on mid-window
// doesn't reset the clock a user already started watching.
function initSessionTracking(): void {
  if (sessionStarted) { return; }
  sessionStarted = true;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const cacheSnapshot = ws ? new SemanticCacheStore(ws).stats() : null;
  const callCountsSnapshot = ws ? new CallLogStore(ws).counts() : null;
  startSession(cacheSnapshot, Date.now, callCountsSnapshot);
}

async function autoApply(config: ReturnType<typeof getConfig>): Promise<void> {
  outputChannel.appendLine('[auto-apply] Starting auto-apply...');

  // 1. Generate instruction files
  try {
    const results = await generateAllInstructions(config);
    for (const result of results) {
      if (result.created) {
        outputChannel.appendLine(`[auto-apply] Created: ${result.filePath}`);
      } else if (result.updated) {
        outputChannel.appendLine(`[auto-apply] Updated: ${result.filePath}`);
      } else if (result.skipped) {
        outputChannel.appendLine(`[auto-apply] Skipped (unchanged): ${result.filePath}`);
      }
    }
    const created = results.filter(r => r.created).length;
    const updated = results.filter(r => r.updated).length;
    if (created > 0 || updated > 0) {
      vscode.window.showInformationMessage(
        `AI Token Optimizer: ${created} instruction files created, ${updated} updated`
      );
    }
  } catch (err) {
    outputChannel.appendLine(`[auto-apply] Instruction generation failed: ${err}`);
  }

  // 2. Install tools silently
  if (config.autoInstallTools) {
    try {
      await installAllTools(outputChannel);
    } catch (err) {
      outputChannel.appendLine(`[auto-apply] Tool installation failed: ${err}`);
    }
  }

  // 3. Configure MCP servers
  if (config.configureMcpOnActivation) {
    try {
      await configureMcpServers(outputChannel, extensionPath);
    } catch (err) {
      outputChannel.appendLine(`[auto-apply] MCP configuration failed: ${err}`);
    }
  }

  outputChannel.appendLine('[auto-apply] Complete');
}

async function toggleAllCommand(): Promise<void> {
  const config = getConfig();
  const wsConfig = vscode.workspace.getConfiguration('aiTokenOptimizer');
  const newEnabled = !config.enabled;
  await wsConfig.update('enabled', newEnabled, vscode.ConfigurationTarget.Workspace);
  updateStatusBar();
  vscode.window.showInformationMessage(
    `AI Token Optimizer: ${newEnabled ? 'Enabled' : 'Disabled'}`
  );

  if (newEnabled) {
    initSessionTracking();
    await autoApply(getConfig());
  }
}

async function regenerateCommand(): Promise<void> {
  const config = getConfig();

  // Regenerate the MANAGED BLOCK, honouring preserveExistingInstructions.
  //
  // This used to force that flag off, so the one command whose name sounds
  // harmless was the one path that discarded content the extension never
  // wrote. A repo that tracks .github/copilot-instructions.md in git keeps its
  // own guidance above the markers — including, in at least one case, the
  // paragraph telling a fresh clone that the tools named in the generated
  // block are optional. Overwriting that silently is a data loss, and the
  // setting exists precisely to say whether it is wanted.
  const overwriting = !config.preserveExistingInstructions;
  if (overwriting && !(await confirmWholesaleOverwrite())) {
    return;
  }

  const results = await generateAllInstructions(config);
  const changed = results.filter(r => r.created || r.updated).length;
  const unchanged = results.filter(r => r.skipped).length;
  vscode.window.showInformationMessage(
    `AI Token Optimizer: Regenerated ${changed} instruction file${changed === 1 ? '' : 's'}` +
      (unchanged > 0 ? ` (${unchanged} already current)` : '') +
      (overwriting ? ' — whole-file overwrite' : '')
  );
}

/**
 * `preserveExistingInstructions: false` means every instruction file is
 * rewritten wholesale. Name the files that would lose authored content before
 * doing it, rather than reporting the count afterwards.
 */
async function confirmWholesaleOverwrite(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return true;
  }

  const atRisk = [
    COPILOT_INSTRUCTIONS_PATH,
    CLAUDE_INSTRUCTIONS_PATH,
    CODEX_INSTRUCTIONS_PATH,
  ].filter(relativePath => {
    const absolutePath = path.join(folders[0].uri.fsPath, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return false;
    }
    try {
      return hasAuthoredContent(fs.readFileSync(absolutePath, 'utf-8'));
    } catch {
      return false;
    }
  });

  if (atRisk.length === 0) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    'AI Token Optimizer: preserveExistingInstructions is off, so these files will be overwritten ' +
      `whole, losing anything written outside the markers:\n\n${atRisk.join('\n')}`,
    { modal: true },
    'Overwrite'
  );
  return choice === 'Overwrite';
}

async function clearCacheCommand(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showWarningMessage('AI Token Optimizer: No workspace folder open');
    return;
  }
  const store = new SemanticCacheStore(workspaceFolders[0].uri.fsPath);
  const stats = store.stats();
  store.clear();
  outputChannel.appendLine(`[cache] Cleared semantic cache (${stats.entries} entries, ${stats.totalHits} lifetime hits)`);
  vscode.window.showInformationMessage(`AI Token Optimizer: Semantic cache cleared (${stats.entries} entries removed)`);
}

async function onConfigChanged(): Promise<void> {
  const config = getConfig();
  if (config.enabled && config.autoApply) {
    try {
      await generateAllInstructions(config);
      outputChannel.appendLine('[config-change] Instruction files updated for new configuration');
    } catch (err) {
      outputChannel.appendLine(`[config-change] Failed to update instructions: ${err}`);
    }
  }
}

export function deactivate(): void {
  disposeStatusBar();
  disposeCodeGraphWatcher();
  if (outputChannel) {
    outputChannel.dispose();
  }
}
