// Public surface of the telemetry layer + the orchestration the dashboard uses.
// Pure Node — the caller supplies workspace/project info, so this stays testable
// without vscode.
import { RepositoryMetricsCollector } from './repositoryCollector';
import { estimateSavings } from './estimator';
import { TelemetryStore } from './store';
import { ExportInput } from './export';
import {
  CollectContext,
  DEFAULT_ASSUMPTIONS,
  MetricSnapshot,
  RepositoryMetrics,
  SavingsAssumptions,
  SavingsEstimate,
} from './types';

export * from './types';
export { RepositoryMetricsCollector } from './repositoryCollector';
export { estimateSavings } from './estimator';
export { TelemetryStore, TELEMETRY_DIR } from './store';
export type { HistoryRow } from './store';
export { summarizeWindow, repositoriesInHistory, WINDOWS } from './analytics';
export type { WindowKey, WindowSummary, MetricKey, MetricTrend } from './analytics';
export { sparklineSvg } from './sparkline';
export { exportTelemetry, EXPORT_EXTENSIONS } from './export';
export type { ExportFormat, ExportInput } from './export';

/** What the dashboard renders in one pass. */
export interface RepositoryTelemetry {
  snapshot: MetricSnapshot<RepositoryMetrics[]>;
  /** Per-repository savings estimate, aligned by index with snapshot.data. */
  estimates: SavingsEstimate[];
}

/** Color-coded rating for a metric. Maps to 🟢 / 🟡 / 🔴 in the UI. */
export type Rating = 'excellent' | 'good' | 'needs-improvement';

export interface RatingBand {
  /** Lower bound (inclusive) for 'excellent'. */
  excellentAtLeast: number;
  /** Lower bound (inclusive) for 'good'. Below this is 'needs-improvement'. */
  goodAtLeast: number;
  /** When true, lower values are better (e.g. latency): bands are read inverted. */
  lowerIsBetter?: boolean;
}

export function rate(value: number, band: RatingBand): Rating {
  if (band.lowerIsBetter) {
    if (value <= band.excellentAtLeast) { return 'excellent'; }
    if (value <= band.goodAtLeast) { return 'good'; }
    return 'needs-improvement';
  }
  if (value >= band.excellentAtLeast) { return 'excellent'; }
  if (value >= band.goodAtLeast) { return 'good'; }
  return 'needs-improvement';
}

/**
 * Runs the repository collector, computes the labeled savings estimate, and
 * persists both the latest snapshot and a history row. Returns everything the
 * dashboard needs. Never throws — a collector failure surfaces as a non-ok
 * snapshot status, consistent with the rest of the dashboard.
 */
export async function collectRepositoryTelemetry(
  context: CollectContext,
  assumptions: SavingsAssumptions = DEFAULT_ASSUMPTIONS,
  collectorEnabled: () => boolean = () => true,
): Promise<RepositoryTelemetry> {
  const collector = new RepositoryMetricsCollector(collectorEnabled);
  const snapshot = await collector.collect(context);

  const repos = snapshot.status === 'ok' ? snapshot.data ?? [] : [];
  const estimates = repos.map((r) => estimateSavings(r, assumptions));

  if (repos.length > 0) {
    try {
      new TelemetryStore(context.workspaceRoot, context.now).recordRepositories(repos);
    } catch {
      // Persistence is best-effort; a write failure must not break the dashboard.
    }
  }

  return { snapshot, estimates };
}

/**
 * Assemble an export payload from persisted telemetry (latest snapshot +
 * history), recomputing the modeled estimates. Returns null when nothing has
 * been collected yet. Used by the export command.
 */
export function gatherExportInput(
  workspaceRoot: string,
  assumptions: SavingsAssumptions = DEFAULT_ASSUMPTIONS,
  now: () => number = Date.now,
): ExportInput | null {
  const store = new TelemetryStore(workspaceRoot, now);
  const latest = store.readLatest();
  const history = store.readHistory();
  if (!latest && history.length === 0) { return null; }

  const repositories = latest?.repositories ?? [];
  return {
    generatedAt: now(),
    repositories,
    estimates: repositories.map((r) => estimateSavings(r, assumptions)),
    history,
  };
}
