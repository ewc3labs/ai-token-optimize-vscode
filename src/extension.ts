import * as vscode from 'vscode';
import { getConfig } from './config';
import { showProjectPicker } from './ui/projectPicker';
import { generateAllInstructions } from './generators';
import { installAllTools } from './installer';
import { configureMcpServers } from './mcp';
import { createStatusBar, updateStatusBar, disposeStatusBar } from './ui/statusBar';
import { showProfilePicker } from './ui/quickPick';
import { DashboardPanel } from './ui/dashboard';
import { startCodeGraphWatcher, runCodeGraphReindex, validateIndex, disposeCodeGraphWatcher, validateAllStrategies } from './strategies';

let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('AI Token Optimizer');
  outputChannel.appendLine('[activate] AI Token Optimizer starting...');

  const config = getConfig();

  if (!config.enabled) {
    outputChannel.appendLine('[activate] Extension disabled via settings');
    return;
  }

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
    vscode.commands.registerCommand('aiTokenOptimizer.configureMcp', () => configureMcpServers(outputChannel)),
    vscode.commands.registerCommand('aiTokenOptimizer.validateAll', () => validateAllStrategies(outputChannel)),
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
      await configureMcpServers(outputChannel);
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
    await autoApply(getConfig());
  }
}

async function regenerateCommand(): Promise<void> {
  const config = getConfig();
  // Force regenerate by temporarily disabling preserve
  const overrideConfig = { ...config, preserveExistingInstructions: false };
  const results = await generateAllInstructions(overrideConfig);
  const count = results.filter(r => r.created || r.updated).length;
  vscode.window.showInformationMessage(
    `AI Token Optimizer: Regenerated ${count} instruction files`
  );
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
