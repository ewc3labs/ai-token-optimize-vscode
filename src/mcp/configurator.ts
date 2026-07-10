import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isBinaryAvailable } from '../installer/installer';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export function detectExistingMcpConfig(workspacePath: string): { vscode: boolean; claude: boolean } {
  const vscodeMcp = hasVsCodeMcpConfig(workspacePath);
  const claudeMcp = hasClaudeMcpConfig();
  return { vscode: vscodeMcp, claude: claudeMcp };
}

function hasVsCodeMcpConfig(workspacePath: string): boolean {
  const settingsPath = path.join(workspacePath, '.vscode', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return false;
  }
  try {
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return !!content['mcp'] || !!content['github.copilot.chat.mcp'];
  } catch {
    return false;
  }
}

function hasClaudeMcpConfig(): boolean {
  const homedir = require('os').homedir();
  const claudeConfigPath = path.join(homedir, '.config', 'claude', 'mcp.json');
  return fs.existsSync(claudeConfigPath);
}

function detectProjectLanguages(workspacePath: string): string[] {
  const languages: string[] = [];

  if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
    languages.push('javascript', 'typescript');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['react'] || allDeps['next']) { languages.push('react'); }
      if (allDeps['next']) { languages.push('nextjs'); }
      if (allDeps['vue']) { languages.push('vue'); }
      if (allDeps['express'] || allDeps['fastify']) { languages.push('node-server'); }
    } catch { /* ignore */ }
  }

  if (fs.existsSync(path.join(workspacePath, 'pyproject.toml')) || fs.existsSync(path.join(workspacePath, 'requirements.txt'))) {
    languages.push('python');
    try {
      const pyproject = fs.readFileSync(path.join(workspacePath, 'pyproject.toml'), 'utf-8');
      if (pyproject.includes('fastapi')) { languages.push('fastapi'); }
      if (pyproject.includes('django')) { languages.push('django'); }
      if (pyproject.includes('flask')) { languages.push('flask'); }
      if (pyproject.includes('pydantic')) { languages.push('pydantic'); }
      if (pyproject.includes('polars')) { languages.push('polars'); }
      if (pyproject.includes('pytest')) { languages.push('pytest'); }
    } catch { /* ignore */ }
  }

  if (fs.existsSync(path.join(workspacePath, 'go.mod'))) {
    languages.push('go');
  }
  if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
    languages.push('rust');
  }

  return languages;
}

export async function configureMcpServers(outputChannel: vscode.OutputChannel): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    outputChannel.appendLine('[mcp] No workspace folder — skipping MCP configuration');
    return;
  }

  const wsPath = workspaceFolders[0].uri.fsPath;
  const languages = detectProjectLanguages(wsPath);
  outputChannel.appendLine(`[mcp] Detected languages/frameworks: ${languages.join(', ') || 'none'}`);

  // Configure VS Code MCP settings for Copilot
  await configureVsCodeMcp(wsPath, languages, outputChannel);

  // Configure Claude Code MCP
  await configureClaudeMcp(languages, outputChannel);
}

async function configureVsCodeMcp(wsPath: string, languages: string[], outputChannel: vscode.OutputChannel): Promise<void> {
  const settingsPath = path.join(wsPath, '.vscode', 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      outputChannel.appendLine('[mcp] Could not parse .vscode/settings.json — creating fresh');
    }
  } else {
    const vscodePath = path.join(wsPath, '.vscode');
    if (!fs.existsSync(vscodePath)) {
      fs.mkdirSync(vscodePath, { recursive: true });
    }
  }

  const mcpServers: Record<string, unknown> = (settings['mcp'] as Record<string, unknown>)?.['servers'] as Record<string, unknown> || {};

  // RTK uses a PreToolUse hook (not MCP) — remove any stale rtk MCP entry
  if ('rtk' in mcpServers) {
    delete mcpServers['rtk'];
    outputChannel.appendLine('[mcp] Removed stale rtk MCP entry (RTK uses hooks, not MCP)');
  }

  // Add Context7 for documentation lookup
  if (!mcpServers['context7']) {
    mcpServers['context7'] = {
      command: 'npx',
      args: ['-y', '@context7/mcp-server'],
      env: {},
    };
    outputChannel.appendLine('[mcp] Added Context7 MCP server for documentation lookup');
  }

  // Add CodeGraph MCP server if the binary is available.
  // codegraph mcp starts the MCP server in stdio mode (tool: codegraph_explore).
  // Users can also run `codegraph install` for full agent wiring.
  if (isBinaryAvailable('codegraph') && !mcpServers['codegraph']) {
    mcpServers['codegraph'] = {
      command: 'codegraph',
      args: ['mcp'],
      type: 'stdio',
    };
    outputChannel.appendLine('[mcp] Added CodeGraph MCP server (codegraph_explore tool)');
  }

  settings['mcp'] = { servers: mcpServers };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  outputChannel.appendLine('[mcp] Updated .vscode/settings.json with MCP configuration');
}

async function configureClaudeMcp(languages: string[], outputChannel: vscode.OutputChannel): Promise<void> {
  const homedir = require('os').homedir();
  const claudeConfigDir = path.join(homedir, '.config', 'claude');
  const claudeConfigPath = path.join(claudeConfigDir, 'mcp.json');

  let config: McpConfig = { servers: {} };

  if (fs.existsSync(claudeConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
      if (!config.servers) {
        config.servers = {};
      }
    } catch {
      outputChannel.appendLine('[mcp] Could not parse Claude MCP config — creating fresh');
    }
  } else {
    if (!fs.existsSync(claudeConfigDir)) {
      fs.mkdirSync(claudeConfigDir, { recursive: true });
    }
  }

  // RTK uses a PreToolUse hook (not MCP) — remove any stale rtk MCP entry
  if ('rtk' in config.servers) {
    delete config.servers['rtk'];
    outputChannel.appendLine('[mcp] Removed stale rtk MCP entry from Claude config');
  }

  // Add Context7
  if (!config.servers['context7']) {
    config.servers['context7'] = {
      command: 'npx',
      args: ['-y', '@context7/mcp-server'],
    };
    outputChannel.appendLine('[mcp] Added Context7 to Claude MCP config');
  }

  // Add CodeGraph if installed
  if (isBinaryAvailable('codegraph') && !config.servers['codegraph']) {
    config.servers['codegraph'] = {
      command: 'codegraph',
      args: ['mcp'],
    };
    outputChannel.appendLine('[mcp] Added CodeGraph to Claude MCP config (codegraph_explore tool)');
  }

  fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  outputChannel.appendLine('[mcp] Updated Claude MCP configuration');
}
