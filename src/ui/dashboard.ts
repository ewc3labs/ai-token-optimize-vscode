import * as vscode from 'vscode';
import { getConfig, getEffectiveStrategies, ExtensionConfig, StrategyState } from '../config';
import { getDetectedTools } from '../generators';
import { measureRtk, measureCodeGraph, measureVerbosity, measureSession, measureSemanticCache, Measurement } from '../strategies';

interface DashboardMeasurements {
  codeGraph: Measurement;
  outputCompression: Measurement;
  verbosityControl: Measurement;
  sessionManagement: Measurement;
  semanticCache: Measurement;
}

export class DashboardPanel {
  private static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static async show(_extensionUri: vscode.Uri): Promise<void> {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      await DashboardPanel.currentPanel.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiTokenOptimizerDashboard',
      'Token Optimization Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel);
    await DashboardPanel.currentPanel.refresh();
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) { d.dispose(); }
    }
  }

  /** Runs the live measurements (real command executions — not instant) then renders. */
  private async refresh(): Promise<void> {
    const config = getConfig();
    const strategies = getEffectiveStrategies(config);

    this.panel.webview.html = this.getLoadingContent();

    const measurements: DashboardMeasurements = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AI Token Optimizer: running live measurements…', cancellable: false },
      async () => ({
        codeGraph: measureCodeGraph(strategies),
        outputCompression: measureRtk(strategies),
        verbosityControl: measureVerbosity(strategies),
        sessionManagement: measureSession(strategies),
        semanticCache: measureSemanticCache(strategies),
      })
    );

    if (this.panel !== DashboardPanel.currentPanel?.panel) { return; } // disposed while measuring
    this.panel.webview.html = this.getHtmlContent(config, strategies, measurements);
  }

  private getLoadingContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Token Optimization Dashboard</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); padding: 40px; }
</style>
</head>
<body>
  <h1>⚡ Token Optimization Dashboard</h1>
  <p>Running live measurements against this workspace (real commands, not estimates) — this takes a few seconds…</p>
</body>
</html>`;
  }

  private statusBadge(m: Measurement): string {
    const map: Record<Measurement['status'], { label: string; cls: string }> = {
      measured: { label: 'MEASURED', cls: 'badge-measured' },
      'no-data': { label: 'NO DATA', cls: 'badge-nodata' },
      unavailable: { label: 'NOT INSTALLED', cls: 'badge-nodata' },
      disabled: { label: 'OFF', cls: 'badge-off' },
      'not-measurable': { label: 'NOT MEASURABLE', cls: 'badge-nodata' },
    };
    const { label, cls } = map[m.status];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  private strategyCard(title: string, icon: string, m: Measurement): string {
    const valueClass = m.status === 'measured' ? 'active' : m.status === 'disabled' ? 'off' : 'inactive';
    const barWidth = m.status === 'measured' && m.percent !== undefined ? Math.max(0, Math.min(100, m.percent)) : 0;

    return `
    <div class="card">
      <h3>${icon} ${title}</h3>
      ${this.statusBadge(m)}
      <div class="value ${valueClass}">${m.status === 'measured' && m.percent !== undefined ? `-${m.percent}%` : ''}</div>
      <div class="bar-track"><div class="bar" style="width: ${barWidth}%"></div></div>
      <p class="detail">${m.detail}</p>
    </div>`;
  }

  private getHtmlContent(config: ExtensionConfig, strategies: StrategyState, measurements: DashboardMeasurements): string {
    const detectedTools = getDetectedTools();
    const activeCount = Object.values(strategies).filter(Boolean).length;

    const measuredPercents = [measurements.codeGraph, measurements.outputCompression]
      .filter(m => m.status === 'measured' && m.percent !== undefined)
      .map(m => m.percent as number);
    const headlineText = measuredPercents.length > 0
      ? `~${Math.round(measuredPercents.reduce((a, b) => a + b, 0) / measuredPercents.length)}%`
      : 'n/a';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Token Optimization Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: var(--vscode-foreground, #ffffff); margin-bottom: 8px; }
    h2 { color: var(--vscode-foreground, #ffffff); margin-top: 24px; border-bottom: 1px solid var(--vscode-panel-border, #444); padding-bottom: 8px; }
    .summary-card {
      background: var(--vscode-editor-inactiveSelectionBackground, #264f78);
      border-radius: 8px;
      padding: 16px 24px;
      margin: 16px 0;
      display: inline-block;
    }
    .summary-card .number {
      font-size: 48px;
      font-weight: bold;
      color: var(--vscode-charts-green, #4ec9b0);
    }
    .summary-card .label { font-size: 14px; opacity: 0.8; }
    .summary-card .sublabel { font-size: 11px; opacity: 0.6; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
    .card {
      background: var(--vscode-editor-selectionBackground, #264f78);
      border-radius: 6px;
      padding: 16px;
    }
    .card h3 { margin: 0 0 8px; font-size: 14px; }
    .card .value { font-size: 24px; font-weight: bold; margin-top: 6px; }
    .card .detail { font-size: 11.5px; opacity: 0.75; margin-top: 8px; line-height: 1.5; }
    .active { color: var(--vscode-charts-green, #4ec9b0); }
    .inactive { color: var(--vscode-charts-red, #f14c4c); opacity: 0.6; }
    .off { color: var(--vscode-descriptionForeground, #999); opacity: 0.6; }
    .bar { background: var(--vscode-progressBar-background, #0e70c0); height: 8px; border-radius: 4px; margin-top: 8px; }
    .bar-track { background: var(--vscode-input-background, #3c3c3c); height: 8px; border-radius: 4px; }
    .badge {
      display: inline-block;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 2px 7px;
      border-radius: 100px;
      margin-top: 2px;
    }
    .badge-measured { background: rgba(78, 201, 176, 0.18); color: var(--vscode-charts-green, #4ec9b0); }
    .badge-nodata { background: rgba(241, 76, 76, 0.15); color: var(--vscode-charts-orange, #f14c4c); }
    .badge-off { background: rgba(153, 153, 153, 0.2); color: var(--vscode-descriptionForeground, #999); }
    .tool-badge {
      display: inline-block;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #ffffff);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-right: 6px;
    }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
    th { opacity: 0.7; font-weight: 600; }
  </style>
</head>
<body>
  <h1>⚡ Token Optimization Dashboard</h1>
  <p>Live measurements against this workspace, run just now. Strategies without a mechanical way to measure them are labeled instead of guessed.</p>

  <div class="summary-card">
    <div class="number">${headlineText}</div>
    <div class="label">Average of measured strategies</div>
    <div class="sublabel">${measuredPercents.length}/2 measurable strategies produced a number this run — CAP-3/CAP-4 are behavioral, see below</div>
  </div>

  <h2>Strategy Performance</h2>
  <div class="grid">
    ${this.strategyCard('CodeGraph (CAP-1)', '🔍', measurements.codeGraph)}
    ${this.strategyCard('Output Compression (CAP-2)', '📦', measurements.outputCompression)}
    ${this.strategyCard('Verbosity Control (CAP-3)', '🗣️', measurements.verbosityControl)}
    ${this.strategyCard('Session Management (CAP-4)', '🧹', measurements.sessionManagement)}
    ${this.strategyCard('Semantic Cache (CAP-5)', '💾', measurements.semanticCache)}
  </div>

  <h2>Configuration</h2>
  <table>
    <tr><th>Setting</th><th>Value</th></tr>
    <tr><td>Active Profile</td><td><strong>${config.profile}</strong></td></tr>
    <tr><td>Strategies Active</td><td>${activeCount} / 5</td></tr>
    <tr><td>Verbosity Level</td><td>${config.verbosityLevel}</td></tr>
    <tr><td>Target Tools</td><td>${config.targetTools.join(', ')}</td></tr>
    <tr><td>Auto Apply</td><td>${config.autoApply ? 'Yes' : 'No'}</td></tr>
    <tr><td>Auto Install Tools</td><td>${config.autoInstallTools ? 'Yes' : 'No'}</td></tr>
    <tr><td>MCP Auto-Configure</td><td>${config.configureMcpOnActivation ? 'Yes' : 'No'}</td></tr>
  </table>

  <h2>Detected AI Tools</h2>
  <p>
    ${detectedTools.length > 0 ? detectedTools.map(t => `<span class="tool-badge">${t}</span>`).join(' ') : '<em>No AI tool extensions detected (instruction files generated for all configured targets regardless)</em>'}
  </p>

  <p style="opacity: 0.5; font-size: 12px; margin-top: 24px;">
    Re-run <code>Ctrl+Shift+P → AI Token Optimizer: Show Savings Dashboard</code> any time to re-measure —
    every number above comes from a real command executed against this workspace when the panel opened,
    not a fixed estimate.
  </p>
</body>
</html>`;
  }
}
