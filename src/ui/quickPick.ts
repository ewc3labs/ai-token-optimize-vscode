import * as vscode from 'vscode';
import { getConfig, getEffectiveStrategies, updateProfile, updateStrategies, Profile } from '../config';
import { PROFILE_DESCRIPTIONS, STRATEGY_DESCRIPTIONS } from '../constants';

export async function showProfilePicker(): Promise<void> {
  const config = getConfig();
  const enabledLabel = config.enabled
    ? '$(zap-off) Disable Plugin'
    : '$(zap) Enable Plugin';
  const enabledDesc = config.enabled
    ? 'Turn off all token optimizations'
    : 'Turn on token optimizations';

  const items: vscode.QuickPickItem[] = [
    // Plugin toggle + validate at the top
    { label: enabledLabel, description: enabledDesc },
    { label: '$(check-all) Validate All Strategies', description: 'Check CAP-1 through CAP-5 are working' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    // Profiles
    { label: PROFILE_DESCRIPTIONS.full,     description: config.profile === 'full'     ? '(active)' : '' },
    { label: PROFILE_DESCRIPTIONS.debug,    description: config.profile === 'debug'    ? '(active)' : '' },
    { label: PROFILE_DESCRIPTIONS.planning, description: config.profile === 'planning' ? '(active)' : '' },
    { label: PROFILE_DESCRIPTIONS.review,   description: config.profile === 'review'   ? '(active)' : '' },
    { label: PROFILE_DESCRIPTIONS.custom,   description: config.profile === 'custom'   ? '(active)' : '' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(settings-gear) Toggle Individual Strategies...', description: '' },
    { label: '$(dashboard) Show Savings Dashboard', description: '' },
    { label: '$(refresh) Regenerate Instruction Files', description: '' },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Plugin: ${config.enabled ? 'ON' : 'OFF'}  |  Profile: ${config.profile}  |  Select action`,
    title: 'AI Token Optimizer',
  });

  if (!selected) {
    return;
  }

  if (selected.label.includes('Disable Plugin') || selected.label.includes('Enable Plugin')) {
    await vscode.commands.executeCommand('aiTokenOptimizer.toggleAll');
    return;
  }

  if (selected.label.includes('Validate All')) {
    await vscode.commands.executeCommand('aiTokenOptimizer.validateAll');
    return;
  }

  if (selected.label.includes('Toggle Individual')) {
    await showStrategyToggle();
    return;
  }

  if (selected.label.includes('Dashboard')) {
    await vscode.commands.executeCommand('aiTokenOptimizer.showDashboard');
    return;
  }

  if (selected.label.includes('Regenerate')) {
    await vscode.commands.executeCommand('aiTokenOptimizer.regenerateInstructions');
    return;
  }

  // Map selection to profile
  const profileMap: Record<string, Profile> = {};
  for (const [key, desc] of Object.entries(PROFILE_DESCRIPTIONS)) {
    profileMap[desc] = key as Profile;
  }

  const profile = profileMap[selected.label];
  if (profile) {
    await updateProfile(profile);
    vscode.window.showInformationMessage(`AI Token Optimizer: Switched to ${profile} profile`);
  }
}

async function showStrategyToggle(): Promise<void> {
  const config = getConfig();
  const strategies = getEffectiveStrategies(config);

  const items: vscode.QuickPickItem[] = [
    {
      label: `${strategies.codeGraph ? '$(check)' : '$(circle-large-outline)'} CodeGraph Pre-indexing`,
      description: STRATEGY_DESCRIPTIONS.codeGraph,
      picked: strategies.codeGraph,
    },
    {
      label: `${strategies.outputCompression ? '$(check)' : '$(circle-large-outline)'} Output Compression`,
      description: STRATEGY_DESCRIPTIONS.outputCompression,
      picked: strategies.outputCompression,
    },
    {
      label: `${strategies.verbosityControl ? '$(check)' : '$(circle-large-outline)'} Verbosity Control`,
      description: STRATEGY_DESCRIPTIONS.verbosityControl,
      picked: strategies.verbosityControl,
    },
    {
      label: `${strategies.sessionManagement ? '$(check)' : '$(circle-large-outline)'} Session Management`,
      description: STRATEGY_DESCRIPTIONS.sessionManagement,
      picked: strategies.sessionManagement,
    },
    {
      label: `${strategies.semanticCache ? '$(check)' : '$(circle-large-outline)'} Semantic Cache`,
      description: STRATEGY_DESCRIPTIONS.semanticCache,
      picked: strategies.semanticCache,
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Toggle strategies (selecting sets profile to Custom)',
    title: 'AI Token Optimizer — Strategy Toggle',
    canPickMany: true,
  });

  if (!selected) {
    return;
  }

  const newStrategies = {
    codeGraph: selected.some(i => i.label.includes('CodeGraph')),
    outputCompression: selected.some(i => i.label.includes('Output Compression')),
    verbosityControl: selected.some(i => i.label.includes('Verbosity Control')),
    sessionManagement: selected.some(i => i.label.includes('Session Management')),
    semanticCache: selected.some(i => i.label.includes('Semantic Cache')),
  };

  await updateStrategies(newStrategies);
  vscode.window.showInformationMessage(
    `AI Token Optimizer: ${Object.values(newStrategies).filter(Boolean).length}/5 strategies active`
  );
}
