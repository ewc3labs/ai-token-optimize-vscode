import * as vscode from 'vscode';
import { getConfig, getEffectiveStrategies, Profile } from '../config';
import { PROFILE_DESCRIPTIONS } from '../constants';

let statusBarItem: vscode.StatusBarItem;

export function createStatusBar(): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'aiTokenOptimizer.selectProfile';
  updateStatusBar();
  statusBarItem.show();
  return statusBarItem;
}

export function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }

  const config = getConfig();
  if (!config.enabled) {
    statusBarItem.text = '$(zap-off) Token Opt: OFF';
    statusBarItem.tooltip = 'AI Token Optimizer is DISABLED. Click → Enable Plugin.';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  const strategies = getEffectiveStrategies(config);
  const activeCount = Object.values(strategies).filter(Boolean).length;
  const profileLabel = getProfileShortLabel(config.profile);

  statusBarItem.text = `$(zap) ${profileLabel} (${activeCount}/4)`;
  statusBarItem.tooltip = buildTooltip(config.profile, strategies);
  statusBarItem.backgroundColor = activeCount === 4
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

function getProfileShortLabel(profile: Profile): string {
  const labels: Record<Profile, string> = {
    full: 'Full',
    debug: 'Debug',
    planning: 'Plan',
    review: 'Review',
    custom: 'Custom',
  };
  return labels[profile];
}

function buildTooltip(profile: Profile, strategies: { codeGraph: boolean; outputCompression: boolean; verbosityControl: boolean; sessionManagement: boolean }): string {
  const lines = [
    `AI Token Optimizer — ${PROFILE_DESCRIPTIONS[profile]}`,
    '',
    'Active Strategies:',
    `  ${strategies.codeGraph ? '✓' : '✗'} CAP-1: CodeGraph (search-first)`,
    `  ${strategies.outputCompression ? '✓' : '✗'} CAP-2: RTK Output Compression`,
    `  ${strategies.verbosityControl ? '✓' : '✗'} CAP-3: Verbosity Control`,
    `  ${strategies.sessionManagement ? '✓' : '✗'} CAP-4: Session Management`,
    '',
    'Click: change profile / validate / enable-disable',
  ];
  return lines.join('\n');
}

export function disposeStatusBar(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
