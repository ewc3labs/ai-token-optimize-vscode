import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { mergeContent } from './merge';
import { ExtensionConfig, getEffectiveStrategies, StrategyState } from '../config';

export interface GeneratorResult {
  filePath: string;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  reason?: string;
}

export abstract class BaseGenerator {
  protected abstract getRelativePath(): string;
  protected abstract generateContent(strategies: StrategyState, config: ExtensionConfig): string;

  async generate(workspaceFolder: vscode.WorkspaceFolder, config: ExtensionConfig): Promise<GeneratorResult> {
    const relativePath = this.getRelativePath();
    const absolutePath = path.join(workspaceFolder.uri.fsPath, relativePath);
    const strategies = getEffectiveStrategies(config);

    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const newContent = this.generateContent(strategies, config);

    if (!fs.existsSync(absolutePath)) {
      fs.writeFileSync(absolutePath, newContent, 'utf-8');
      return { filePath: absolutePath, created: true, updated: false, skipped: false };
    }

    const existing = fs.readFileSync(absolutePath, 'utf-8');

    if (config.preserveExistingInstructions) {
      const merged = this.mergeContent(existing, newContent);
      if (merged === existing) {
        return { filePath: absolutePath, created: false, updated: false, skipped: true, reason: 'Content unchanged' };
      }
      fs.writeFileSync(absolutePath, merged, 'utf-8');
      return { filePath: absolutePath, created: false, updated: true, skipped: false };
    }

    fs.writeFileSync(absolutePath, newContent, 'utf-8');
    return { filePath: absolutePath, created: false, updated: true, skipped: false };
  }

  protected mergeContent(existing: string, newOptimizationBlock: string): string {
    return mergeContent(existing, newOptimizationBlock);
  }

  protected buildSections(strategies: StrategyState, config: ExtensionConfig): string[] {
    const sections: string[] = [];

    if (strategies.codeGraph) {
      sections.push(this.getCodeGraphSection());
    }
    if (strategies.outputCompression) {
      sections.push(this.getCompressionSection());
    }
    if (strategies.verbosityControl) {
      sections.push(this.getVerbositySection(config.verbosityLevel));
    }
    if (strategies.sessionManagement) {
      sections.push(this.getSessionSection());
    }
    if (strategies.semanticCache) {
      sections.push(this.getCacheSection());
    }

    return sections;
  }

  protected abstract getCodeGraphSection(): string;
  protected abstract getCompressionSection(): string;
  protected abstract getVerbositySection(level: string): string;
  protected abstract getSessionSection(): string;
  protected abstract getCacheSection(): string;
}
