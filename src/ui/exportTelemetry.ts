import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EXPORT_EXTENSIONS, ExportFormat, exportTelemetry, gatherExportInput } from '../telemetry';

const FORMAT_ITEMS: { label: string; description: string; format: ExportFormat }[] = [
  { label: '$(json) JSON', description: 'Full snapshot + estimates + history', format: 'json' },
  { label: '$(table) CSV', description: 'History time-series + current snapshot (opens in Excel/Sheets)', format: 'csv' },
  { label: '$(markdown) Markdown', description: 'Human-readable report', format: 'markdown' },
];

/** Command handler: pick a format, gather persisted telemetry, save to disk. */
export async function exportTelemetryCommand(outputChannel: vscode.OutputChannel): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showWarningMessage('AI Token Optimizer: open a workspace folder first.');
    return;
  }

  const input = gatherExportInput(ws);
  if (!input) {
    vscode.window.showInformationMessage('AI Token Optimizer: no telemetry collected yet. Open the dashboard once to capture repository metrics, then export.');
    return;
  }

  const picked = await vscode.window.showQuickPick(FORMAT_ITEMS, {
    title: 'Export Telemetry',
    placeHolder: 'Choose an export format',
  });
  if (!picked) { return; }

  const content = exportTelemetry(input, picked.format);
  const defaultName = `ai-token-optimizer-telemetry.${EXPORT_EXTENSIONS[picked.format]}`;
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(ws, defaultName)),
    saveLabel: 'Export',
    title: 'Save telemetry export',
  });
  if (!target) { return; }

  try {
    fs.writeFileSync(target.fsPath, content, 'utf-8');
    outputChannel.appendLine(`[telemetry] Exported ${picked.format.toUpperCase()} → ${target.fsPath}`);
    const open = await vscode.window.showInformationMessage(
      `Telemetry exported to ${path.basename(target.fsPath)}`,
      'Open File',
    );
    if (open === 'Open File') {
      await vscode.window.showTextDocument(target);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[telemetry] Export failed: ${message}`);
    vscode.window.showErrorMessage(`AI Token Optimizer: export failed — ${message}`);
  }
}
