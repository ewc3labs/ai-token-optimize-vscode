import * as vscode from 'vscode';
import { getConfig, getEffectiveStrategies, ExtensionConfig, StrategyState } from '../config';
import { getDetectedTools } from '../generators';
import { measureRtk, measureCodeGraph, measureVerbosity, measureSession, measureSemanticCache, measureCacheCalls, Measurement } from '../strategies';
import { getSessionSummary, formatDuration, SessionSummary } from '../session/tracker';
import { SemanticCacheStore } from '../cache/store';
import { CallLogStore } from '../cache/callLog';
import { getProjectsToIndex } from './projectPicker';
import {
  collectRepositoryTelemetry,
  rate,
  Rating,
  RatingBand,
  RepositoryMetrics,
  RepositoryTelemetry,
  SavingsEstimate,
  TelemetryStore,
  summarizeWindow,
  repositoriesInHistory,
  sparklineSvg,
  WINDOWS,
  WindowSummary,
  MetricKey,
} from '../telemetry';
import { HistoryRow } from '../telemetry';

const REFRESH_COMMAND = 'aiTokenOptimizer.showDashboard';
const EXPORT_COMMAND = 'aiTokenOptimizer.exportTelemetry';

interface DashboardMeasurements {
  codeGraph: Measurement;
  outputCompression: Measurement;
  verbosityControl: Measurement;
  sessionManagement: Measurement;
  semanticCache: Measurement;
  cacheCalls: Measurement;
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
      { enableScripts: false, enableCommandUris: [REFRESH_COMMAND, EXPORT_COMMAND] }
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
        cacheCalls: measureCacheCalls(strategies),
      })
    );

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const currentCacheStats = ws ? new SemanticCacheStore(ws).stats() : null;
    const currentCallCounts = ws ? new CallLogStore(ws).counts() : null;
    const session = getSessionSummary(currentCacheStats, Date.now, currentCallCounts);

    const telemetry = ws
      ? await collectRepositoryTelemetry(
          { workspaceRoot: ws, projects: getProjectsToIndex(), now: Date.now },
          undefined,
          () => config.telemetryEnabled,
        )
      : null;
    // Read after collect so the just-captured snapshot is included in the trend.
    const history = ws ? new TelemetryStore(ws).readHistory() : [];

    if (this.panel !== DashboardPanel.currentPanel?.panel) { return; } // disposed while measuring
    this.panel.webview.html = this.getHtmlContent(config, strategies, measurements, session, telemetry, history);
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

  // --- Repository Intelligence (Tier A: real) + Estimated Savings (Tier B: modeled) ---

  private static readonly INDICATOR: Record<Rating, string> = {
    excellent: '🟢 Excellent',
    good: '🟡 Good',
    'needs-improvement': '🔴 Needs Improvement',
  };

  /** A metric cell with an optional color-coded rating chip. */
  private metricCell(label: string, value: string, rating?: Rating): string {
    const chip = rating ? `<span class="ind ind-${rating}">${DashboardPanel.INDICATOR[rating]}</span>` : '';
    return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div>${chip}</div>`;
  }

  private num(n: number): string {
    return n.toLocaleString();
  }

  /** null → an explicit, honest "n/a" rather than a fabricated 0. */
  private obs(n: number | null): string {
    return n === null ? '<span class="na">n/a</span>' : this.num(n);
  }

  private formatBytes(bytes: number): string {
    if (bytes <= 0) { return '0 B'; }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${Math.round((bytes / Math.pow(1024, i)) * 10) / 10} ${units[i]}`;
  }

  private repositorySection(repo: RepositoryMetrics, estimate: SavingsEstimate): string {
    const tokenBand: RatingBand = { excellentAtLeast: 80, goodAtLeast: 50 };
    const filesBand: RatingBand = { excellentAtLeast: 90, goodAtLeast: 60 };
    const tokenRating = rate(estimate.tokenReductionPercent, tokenBand);
    const filesRating = rate(estimate.filesReductionPercent, filesBand);

    const langs = Object.entries(repo.languages)
      .sort((a, b) => b[1] - a[1])
      .map(([l, c]) => `<span class="tool-badge">${l} · ${c}</span>`)
      .join(' ') || '<em>n/a</em>';

    const a = estimate.assumptions;

    return `
    <h3 class="repo-title">📦 ${repo.repositoryName}</h3>
    <p class="repo-source">Read from the CodeGraph index (${repo.source === 'sqlite' ? 'full breakdown' : 'totals only — sqlite3 unavailable'}). These are real index facts, not estimates.</p>
    <div class="metric-grid">
      ${this.metricCell('Files', this.num(repo.totalFiles))}
      ${this.metricCell('Directories', this.num(repo.totalDirectories))}
      ${this.metricCell('Classes', this.num(repo.totalClasses))}
      ${this.metricCell('Interfaces', this.num(repo.totalInterfaces))}
      ${this.metricCell('Enums', this.num(repo.totalEnums))}
      ${this.metricCell('Methods', this.num(repo.totalMethods))}
      ${this.metricCell('Functions', this.num(repo.totalFunctions))}
      ${this.metricCell('Graph Nodes', this.num(repo.totalGraphNodes))}
      ${this.metricCell('Relationships', this.num(repo.totalGraphRelationships))}
      ${this.metricCell('Source Size', this.formatBytes(repo.sourceBytes))}
      ${this.metricCell('Index Size', this.formatBytes(repo.indexSizeBytes))}
      ${this.metricCell('Packages', this.obs(repo.totalPackages))}
      ${this.metricCell('APIs', this.obs(repo.totalApis))}
      ${this.metricCell('DB Queries', this.obs(repo.totalDatabaseQueries))}
      ${this.metricCell('Build Time', repo.graphBuildTimeMs === null ? '<span class="na">n/a</span>' : `${repo.graphBuildTimeMs} ms`)}
    </div>
    <p class="repo-langs">${langs}</p>

    <div class="modeled-banner">⚠️ Estimated savings below are a <strong>model</strong>, not a measurement. This extension is not in the LLM request path, so real per-request token counts can't be observed. Assumptions: whole-repository baseline, ~${a.avgFilesRetrievedPerQuery} files retrieved/query, ${a.charsPerToken} chars/token, $${a.usdPer1kPromptTokens}/1K prompt tokens.</p>
    <div class="metric-grid">
      ${this.metricCell('Prompt Tokens (no graph)', this.num(estimate.estimatedPromptTokensWithoutGraph))}
      ${this.metricCell('Prompt Tokens (graph)', this.num(estimate.estimatedPromptTokensWithGraph))}
      ${this.metricCell('Token Reduction', `${estimate.tokenReductionPercent}%`, tokenRating)}
      ${this.metricCell('Files Reduction', `${estimate.filesReductionPercent}%`, filesRating)}
      ${this.metricCell('Context (no graph)', `${estimate.estimatedContextKbWithoutGraph} KB`)}
      ${this.metricCell('Context (graph)', `${estimate.estimatedContextKbWithGraph} KB`)}
      ${this.metricCell('Est. Cost (no graph)', `$${estimate.estimatedCostWithoutGraphUsd.toFixed(4)}`)}
      ${this.metricCell('Est. Cost Saved / query', `$${estimate.estimatedCostSavedUsd.toFixed(4)}`)}
    </div>`;
  }

  private repositoryIntelligenceHtml(telemetry: RepositoryTelemetry | null): string {
    if (!telemetry) {
      return '';
    }
    if (telemetry.snapshot.status !== 'ok') {
      return `<h2>Repository Intelligence</h2><p class="detail">${telemetry.snapshot.detail}</p>`;
    }
    const repos = telemetry.snapshot.data ?? [];
    const sections = repos.map((r, i) => this.repositorySection(r, telemetry.estimates[i])).join('\n<hr class="repo-sep">\n');
    return `<h2>Repository Intelligence <span class="section-note">real index facts + modeled savings</span></h2>\n${sections}`;
  }

  // --- Repository Growth (Tier A historical: real index snapshots over time) ---

  private static readonly GROWTH_METRICS: { key: MetricKey; label: string }[] = [
    { key: 'files', label: 'Files' },
    { key: 'nodes', label: 'Graph Nodes' },
    { key: 'edges', label: 'Relationships' },
    { key: 'methods', label: 'Methods' },
    { key: 'functions', label: 'Functions' },
    { key: 'indexBytes', label: 'Index Size' },
  ];

  private trendCard(summary: WindowSummary, key: MetricKey, label: string): string {
    const t = summary.trends[key];
    const spark = sparklineSvg(t.series, { width: 180, height: 40 });
    const deltaSign = t.delta > 0 ? '+' : '';
    const deltaPct = t.deltaPercent === null ? '' : ` (${deltaSign}${t.deltaPercent}%)`;
    const deltaClass = t.delta > 0 ? 'up' : t.delta < 0 ? 'down' : 'flat';
    const latest = key === 'indexBytes' ? this.formatBytes(t.latest) : this.num(t.latest);
    const delta = key === 'indexBytes' ? this.formatBytes(Math.abs(t.delta)) : this.num(Math.abs(t.delta));
    return `
    <div class="trend-card">
      <div class="trend-head"><span class="trend-label">${label}</span><span class="trend-latest">${latest}</span></div>
      <div class="spark">${spark}</div>
      <div class="trend-delta ${deltaClass}">${t.delta === 0 ? 'no change' : `${deltaSign}${delta}${deltaPct}`} · ${summary.sampleCount} sample(s)</div>
    </div>`;
  }

  private growthSection(history: HistoryRow[]): string {
    if (history.length === 0) {
      return '';
    }
    const repos = repositoriesInHistory(history);
    // Default to the widest useful window that actually has multiple samples.
    const blocks = repos.map((repo) => {
      const lifetime = summarizeWindow(history, repo, 'lifetime', Date.now());
      if (lifetime.sampleCount < 2) {
        return `<h3 class="repo-title">📈 ${repo}</h3><p class="detail">Only ${lifetime.sampleCount} snapshot so far — trends appear once the dashboard has been opened at least twice (each open captures one snapshot).</p>`;
      }
      const cards = DashboardPanel.GROWTH_METRICS.map((m) => this.trendCard(lifetime, m.key, m.label)).join('\n');
      const windowRows = WINDOWS.map((w) => {
        const s = summarizeWindow(history, repo, w.key, Date.now());
        const files = s.trends.files;
        const nodes = s.trends.nodes;
        return `<tr><td>${w.label}</td><td>${s.sampleCount}</td><td>${files.delta >= 0 ? '+' : ''}${this.num(files.delta)}</td><td>${nodes.delta >= 0 ? '+' : ''}${this.num(nodes.delta)}</td></tr>`;
      }).join('');
      return `
      <h3 class="repo-title">📈 ${repo} <span class="section-note">lifetime trend</span></h3>
      <div class="trend-grid">${cards}</div>
      <table class="window-table">
        <tr><th>Window</th><th>Snapshots</th><th>Δ Files</th><th>Δ Nodes</th></tr>
        ${windowRows}
      </table>`;
    }).join('\n<hr class="repo-sep">\n');

    return `<h2>Repository Growth <span class="section-note">real index snapshots over time</span></h2>\n${blocks}`;
  }

  private getHtmlContent(config: ExtensionConfig, strategies: StrategyState, measurements: DashboardMeasurements, session: SessionSummary, telemetry: RepositoryTelemetry | null, history: HistoryRow[]): string {
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
    .summary-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
    .summary-card {
      background: var(--vscode-editor-inactiveSelectionBackground, #264f78);
      border-radius: 8px;
      padding: 16px 24px;
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
    .refresh-link { font-size: 14px; font-weight: normal; margin-left: 12px; color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
    .refresh-link:hover { text-decoration: underline; }
    .section-note { font-size: 12px; font-weight: normal; opacity: 0.6; }
    .repo-title { margin: 20px 0 2px; font-size: 16px; }
    .repo-source { font-size: 11.5px; opacity: 0.7; margin: 0 0 12px; }
    .repo-langs { margin: 10px 0 4px; }
    .repo-sep { border: none; border-top: 1px solid var(--vscode-panel-border, #333); margin: 24px 0; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 10px 0; }
    .metric {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
      border-radius: 6px; padding: 10px 12px;
    }
    .metric-label { font-size: 11px; opacity: 0.7; }
    .metric-value { font-size: 20px; font-weight: bold; margin-top: 2px; color: var(--vscode-foreground, #fff); }
    .na { opacity: 0.45; font-weight: normal; font-size: 15px; }
    .ind { display: inline-block; font-size: 10px; font-weight: 700; margin-top: 6px; padding: 1px 6px; border-radius: 100px; }
    .ind-excellent { background: rgba(78, 201, 176, 0.18); color: var(--vscode-charts-green, #4ec9b0); }
    .ind-good { background: rgba(229, 192, 123, 0.18); color: var(--vscode-charts-yellow, #e5c07b); }
    .ind-needs-improvement { background: rgba(241, 76, 76, 0.15); color: var(--vscode-charts-red, #f14c4c); }
    .modeled-banner {
      background: rgba(229, 192, 123, 0.10);
      border-left: 3px solid var(--vscode-charts-yellow, #e5c07b);
      border-radius: 4px; padding: 10px 14px; margin: 18px 0 6px; font-size: 12px; line-height: 1.5;
    }
    .trend-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin: 12px 0; }
    .trend-card { background: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e); border-radius: 6px; padding: 12px; }
    .trend-head { display: flex; justify-content: space-between; align-items: baseline; }
    .trend-label { font-size: 12px; opacity: 0.75; }
    .trend-latest { font-size: 18px; font-weight: bold; color: var(--vscode-foreground, #fff); }
    .spark { margin: 6px 0 4px; }
    .spark svg { display: block; width: 100%; height: 40px; }
    .trend-delta { font-size: 11px; opacity: 0.8; }
    .trend-delta.up { color: var(--vscode-charts-green, #4ec9b0); }
    .trend-delta.down { color: var(--vscode-charts-red, #f14c4c); }
    .trend-delta.flat { opacity: 0.55; }
    .window-table { width: auto; margin: 12px 0; font-size: 12.5px; }
    .window-table td, .window-table th { padding: 5px 16px 5px 0; border: none; }
  </style>
</head>
<body>
  <h1>⚡ Token Optimization Dashboard <a class="refresh-link" href="command:${REFRESH_COMMAND}">↻ Refresh</a><a class="refresh-link" href="command:${EXPORT_COMMAND}">⬇ Export</a></h1>
  <p>Measurements against this workspace, refreshed just now. Strategies without a mechanical way to measure them are labeled instead of guessed.</p>

  <div class="summary-row">
    <div class="summary-card">
      <div class="number">${headlineText}</div>
      <div class="label">RTK savings (CAP-2) — lifetime</div>
      <div class="sublabel">From rtk's own log ('rtk gain --project'), this workspace, all-time — not a live benchmark. Tracks CLI output compression only, not LLM tokens or model choice. CodeGraph (CAP-1) reports real index stats instead of a %; CAP-3/CAP-4 are behavioral, not mechanically measurable — see cards below.</div>
    </div>
    <div class="summary-card">
      <div class="number">${formatDuration(session.elapsedMs)}</div>
      <div class="label">Elapsed this session</div>
      <div class="sublabel">${session.cacheHitsThisSession} semantic-cache hit(s), ~${session.tokensSavedThisSession} tokens served from cache, ${session.mcpLookupsThisSession} MCP call(s) (${session.mcpHitsThisSession} hit / ${session.mcpMissesThisSession} miss), ${session.reindexCount} CodeGraph reindex(es) — since this VS Code window opened, resets on reload</div>
    </div>
  </div>

  <h2>Strategy Performance</h2>
  <div class="grid">
    ${this.strategyCard('CodeGraph (CAP-1)', '🔍', measurements.codeGraph)}
    ${this.strategyCard('Output Compression (CAP-2)', '📦', measurements.outputCompression)}
    ${this.strategyCard('Verbosity Control (CAP-3)', '🗣️', measurements.verbosityControl)}
    ${this.strategyCard('Session Management (CAP-4)', '🧹', measurements.sessionManagement)}
    ${this.strategyCard('Semantic Cache (CAP-5)', '💾', measurements.semanticCache)}
    ${this.strategyCard('MCP Tool Calls (token-cache)', '🔌', measurements.cacheCalls)}
  </div>

  ${this.repositoryIntelligenceHtml(telemetry)}

  ${this.growthSection(history)}

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
    Click "↻ Refresh" above (or re-run <code>Ctrl+Shift+P → AI Token Optimizer: Show Savings Dashboard</code>) any time to re-measure —
    every number above is read fresh from real local state (rtk's own log, the semantic-cache file, CodeGraph's index, this window's session counters)
    when the panel loads, not a fixed estimate.
  </p>
</body>
</html>`;
  }
}
