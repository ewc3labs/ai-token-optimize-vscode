import * as vscode from 'vscode';
import { setToolPathOverrides } from './installer/toolResolver';

export type Profile = 'full' | 'debug' | 'planning' | 'review' | 'custom';
export type VerbosityLevel = 'light' | 'full' | 'ultra';
export type TargetTool = 'copilot' | 'claude' | 'codex';

export interface StrategyState {
  codeGraph: boolean;
  outputCompression: boolean;
  verbosityControl: boolean;
  sessionManagement: boolean;
  semanticCache: boolean;
}

export interface CodeGraphProject {
  name: string;      // Display name shown in UI
  path: string;      // Absolute or workspace-relative path
  enabled: boolean;  // Whether this project is actively indexed
}

export interface ExtensionConfig {
  enabled: boolean;
  autoApply: boolean;
  targetTools: TargetTool[];
  profile: Profile;
  activeStrategies: StrategyState;
  verbosityLevel: VerbosityLevel;
  preserveExistingInstructions: boolean;
  autoInstallTools: boolean;
  configureMcpOnActivation: boolean;
  codeGraphProjects: CodeGraphProject[];
  telemetryEnabled: boolean;
  /** Explicit binary locations, e.g. { codegraph: "C:\\tools\\codegraph.cmd" }. */
  toolPaths: Record<string, string>;
}

const PROFILE_STRATEGIES: Record<Profile, StrategyState> = {
  full: { codeGraph: true, outputCompression: true, verbosityControl: true, sessionManagement: true, semanticCache: true },
  debug: { codeGraph: true, outputCompression: false, verbosityControl: true, sessionManagement: true, semanticCache: true },
  planning: { codeGraph: true, outputCompression: true, verbosityControl: false, sessionManagement: true, semanticCache: true },
  review: { codeGraph: true, outputCompression: true, verbosityControl: true, sessionManagement: false, semanticCache: true },
  custom: { codeGraph: true, outputCompression: true, verbosityControl: true, sessionManagement: true, semanticCache: true },
};

export function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('aiTokenOptimizer');
  return {
    enabled: config.get<boolean>('enabled', true),
    autoApply: config.get<boolean>('autoApply', true),
    targetTools: config.get<TargetTool[]>('targetTools', ['copilot', 'claude', 'codex']),
    profile: config.get<Profile>('profile', 'full'),
    activeStrategies: config.get<StrategyState>('activeStrategies', PROFILE_STRATEGIES.full),
    verbosityLevel: config.get<VerbosityLevel>('verbosityLevel', 'full'),
    preserveExistingInstructions: config.get<boolean>('preserveExistingInstructions', true),
    autoInstallTools: config.get<boolean>('autoInstallTools', true),
    configureMcpOnActivation: config.get<boolean>('configureMcpOnActivation', true),
    codeGraphProjects: config.get<CodeGraphProject[]>('codeGraphProjects', []),
    telemetryEnabled: config.get<boolean>('telemetry.enabled', true),
    toolPaths: config.get<Record<string, string>>('toolPaths', {}),
  };
}

/**
 * Pushes the configured tool paths into the resolver. Called on activation and
 * whenever settings change, so a user who points the extension at an existing
 * install does not have to reload the window.
 */
export function applyToolPathOverrides(config: ExtensionConfig = getConfig()): void {
  setToolPathOverrides(config.toolPaths ?? {});
}

export function getEffectiveStrategies(config: ExtensionConfig): StrategyState {
  if (config.profile === 'custom') {
    return config.activeStrategies;
  }
  return PROFILE_STRATEGIES[config.profile];
}

export async function updateProfile(profile: Profile): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiTokenOptimizer');
  await config.update('profile', profile, vscode.ConfigurationTarget.Workspace);
}

export async function updateStrategies(strategies: Partial<StrategyState>): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiTokenOptimizer');
  const current = config.get<StrategyState>('activeStrategies', PROFILE_STRATEGIES.full);
  await config.update('activeStrategies', { ...current, ...strategies }, vscode.ConfigurationTarget.Workspace);
  await config.update('profile', 'custom', vscode.ConfigurationTarget.Workspace);
}

export async function saveCodeGraphProjects(projects: CodeGraphProject[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiTokenOptimizer');
  await config.update('codeGraphProjects', projects, vscode.ConfigurationTarget.Workspace);
}
