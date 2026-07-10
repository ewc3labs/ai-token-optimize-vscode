import * as vscode from 'vscode';
import { ExtensionConfig } from '../config';
import { CopilotGenerator } from './copilot';
import { ClaudeGenerator } from './claude';
import { CodexGenerator } from './codex';
import { GeneratorResult, BaseGenerator } from './base';
import { COPILOT_EXTENSION_ID, CLAUDE_EXTENSION_ID, CODEX_EXTENSION_ID } from '../constants';

export { GeneratorResult } from './base';

const generators: Record<string, { generator: BaseGenerator; extensionId: string }> = {
  copilot: { generator: new CopilotGenerator(), extensionId: COPILOT_EXTENSION_ID },
  claude: { generator: new ClaudeGenerator(), extensionId: CLAUDE_EXTENSION_ID },
  codex: { generator: new CodexGenerator(), extensionId: CODEX_EXTENSION_ID },
};

export async function generateAllInstructions(config: ExtensionConfig): Promise<GeneratorResult[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return [];
  }

  const results: GeneratorResult[] = [];
  const primaryFolder = workspaceFolders[0];

  for (const tool of config.targetTools) {
    const entry = generators[tool];
    if (!entry) {
      continue;
    }

    // Generate regardless of whether the AI tool extension is installed
    // The instruction files work even if the tool is installed later
    const result = await entry.generator.generate(primaryFolder, config);
    results.push(result);
  }

  return results;
}

export function getDetectedTools(): string[] {
  const detected: string[] = [];
  for (const [tool, { extensionId }] of Object.entries(generators)) {
    if (vscode.extensions.getExtension(extensionId)) {
      detected.push(tool);
    }
  }
  return detected;
}
