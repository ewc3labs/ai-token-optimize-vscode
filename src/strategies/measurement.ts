import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import { StrategyState } from '../config';
import { isBinaryAvailable } from '../installer/installer';
import { getProjectsToIndex } from '../ui/projectPicker';
import { memoizeTtl } from '../cache/ttlCache';
import { SemanticCacheStore } from '../cache/store';
import { CallLogStore } from '../cache/callLog';
import { getRtkGain } from './rtkGain';
import { runTool } from '../installer/platform';

const MEASURE_TTL_MS = 5 * 60_000;

/**
 * Live measurements for the Savings Dashboard. Unlike the old static
 * CAP-1..4 percentages, everything here is either:
 *  - a real command run twice (raw vs. via the tool) on this workspace, or
 *  - real state read from the tool's own index/history, or
 *  - explicitly marked as not mechanically measurable.
 * No number here is guessed.
 */

export type MeasurementStatus = 'measured' | 'no-data' | 'unavailable' | 'disabled' | 'not-measurable';

export interface Measurement {
  status: MeasurementStatus;
  /** Only set when status === 'measured' and the result is a single % figure. */
  percent?: number;
  detail: string;
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 5000): { out: string; ok: boolean } {
  // runTool, not spawnSync: `codegraph` is a .cmd shim on Windows (see installer/platform).
  const r = runTool(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf-8', cwd });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), ok: r.status === 0 && !r.error };
}

function primaryWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * CAP-2: real, locally-persisted savings from `rtk gain --format json --all
 * --project` — rtk's own accumulated log of commands it has actually
 * compressed for this workspace, lifetime. Replaces an earlier synthetic
 * 'ls'/'find' live-diff benchmark that re-ran fresh on every dashboard open
 * and had no relationship to real usage (that number was the source of
 * confusion — a single -87% with nothing behind it).
 */
export function measureRtk(strategies: StrategyState): Measurement {
  if (!strategies.outputCompression) {
    return { status: 'disabled', detail: 'Strategy disabled in current profile' };
  }
  if (!isBinaryAvailable('rtk')) {
    return { status: 'unavailable', detail: 'rtk binary not installed — run "AI Token Optimizer: Install Optimization Tools"' };
  }
  const ws = primaryWorkspacePath();
  if (!ws) {
    return { status: 'no-data', detail: 'No workspace folder open to benchmark against' };
  }

  return memoizeTtl(`measure:rtk:${ws}`, MEASURE_TTL_MS, () => measureRtkLive(ws));
}

function measureRtkLive(ws: string): Measurement {
  const result = getRtkGain(ws);
  if (result.status === 'no-data') {
    return { status: 'no-data', detail: result.detail };
  }
  if (result.status === 'error') {
    return { status: 'unavailable', detail: result.detail };
  }
  const s = result.summary!;
  return {
    status: 'measured',
    percent: Math.round(s.avgSavingsPct),
    detail: `Lifetime, this workspace (rtk gain --project): ${s.totalCommands} command(s), ${s.totalSavedTokens} tokens saved of ${s.totalInputTokens} sent (${s.avgSavingsPct.toFixed(1)}%). Tracks RTK CLI output compression only — not LLM conversation tokens or model choice.`,
  };
}

/**
 * CAP-1: CodeGraph's value doesn't reduce to one fair percentage — a targeted
 * symbol query beat grep by ~32% in testing, a broad exploratory query cost
 * 2.6x more because it pulls in related files for context. Rather than
 * average those into a fake number, report the real, live-queried index
 * health instead (files/symbols/edges/freshness) — that's the part that's
 * actually true for *this* workspace, right now.
 */
export function measureCodeGraph(strategies: StrategyState): Measurement {
  if (!strategies.codeGraph) {
    return { status: 'disabled', detail: 'Strategy disabled in current profile' };
  }
  if (!isBinaryAvailable('codegraph')) {
    return { status: 'unavailable', detail: 'codegraph binary not installed — run "AI Token Optimizer: Install Optimization Tools"' };
  }

  const projects = getProjectsToIndex();
  if (projects.length === 0) {
    return { status: 'no-data', detail: 'No workspace folder open to inspect' };
  }

  const cacheKey = `measure:codegraph:${projects.map(p => p.absPath).join(',')}`;
  return memoizeTtl(cacheKey, MEASURE_TTL_MS, () => measureCodeGraphLive(projects));
}

function measureCodeGraphLive(projects: Array<{ name: string; absPath: string }>): Measurement {
  let totalFiles = 0, totalNodes = 0, totalEdges = 0, indexedCount = 0, staleCount = 0;
  for (const project of projects) {
    const result = run('codegraph', ['status'], project.absPath);
    if (!result.ok) { continue; }
    const files = result.out.match(/Files:\s*(\d+)/)?.[1];
    const nodes = result.out.match(/Nodes:\s*(\d+)/)?.[1];
    const edges = result.out.match(/Edges:\s*(\d+)/)?.[1];
    if (!files || !nodes) { continue; }
    indexedCount++;
    totalFiles += Number(files);
    totalNodes += Number(nodes);
    totalEdges += edges ? Number(edges) : 0;
    if (!/up to date/i.test(result.out)) { staleCount++; }
  }

  if (indexedCount === 0) {
    return { status: 'no-data', detail: `${projects.length} project(s) configured, none indexed yet — run "AI Token Optimizer: Reindex CodeGraph"` };
  }

  const freshness = staleCount === 0 ? 'up to date' : `${staleCount}/${indexedCount} project(s) stale — reindex recommended`;
  return {
    status: 'measured',
    detail: `Real index state (queried now): ${totalFiles} files, ${totalNodes} symbols, ${totalEdges} edges across ${indexedCount}/${projects.length} project(s) — ${freshness}. This is index state, not a savings percentage — CodeGraph exposes no per-query metrics locally (no query log or invocation history is persisted anywhere on disk), so a real "% saved" number for CodeGraph cannot be shown here without fabricating it.`,
  };
}

/**
 * CAP-3/CAP-4: these are prose instructions to the model (be terser, run
 * /compact, route to a lighter model), not a mechanical transform. There is
 * no local command whose output before/after can be diffed — the only valid
 * test is a live A/B of actual model responses with and without the
 * instructions applied, which this extension has no mechanism to run.
 */
export function measureVerbosity(strategies: StrategyState): Measurement {
  if (!strategies.verbosityControl) {
    return { status: 'disabled', detail: 'Strategy disabled in current profile' };
  }
  return {
    status: 'not-measurable',
    detail: 'Prose guidance to the model, not a mechanical transform — effect depends on how closely the model follows it. Verifying this requires a live A/B of actual model responses with and without the instruction, which this extension cannot run locally.',
  };
}

export function measureSession(strategies: StrategyState): Measurement {
  if (!strategies.sessionManagement) {
    return { status: 'disabled', detail: 'Strategy disabled in current profile' };
  }
  return {
    status: 'not-measurable',
    detail: 'Guidance for /compact, /clear and model routing — behavioral, not mechanical. Same limitation as CAP-3: only a live model A/B could measure this, and this extension cannot run one locally.',
  };
}

/**
 * CAP-5: real numbers straight from the cache file — entries, recorded hits,
 * and tokens estimated from the actual cached answer sizes. Reported as
 * 'measured' only once at least one hit has happened; never guessed.
 */
export function measureSemanticCache(strategies: StrategyState): Measurement {
  if (!strategies.semanticCache) {
    return { status: 'disabled', detail: 'Strategy disabled in current profile' };
  }
  const ws = primaryWorkspacePath();
  if (!ws) {
    return { status: 'no-data', detail: 'No workspace folder open' };
  }

  const stats = new SemanticCacheStore(ws).stats();
  if (stats.entries === 0) {
    return { status: 'no-data', detail: 'Cache empty — no answers stored yet. AI tools populate it via the token-cache MCP server as you work.' };
  }
  if (stats.totalHits === 0) {
    return { status: 'no-data', detail: `${stats.entries} answer(s) cached, no repeat hits yet — savings appear when a question recurs.` };
  }
  return {
    status: 'measured',
    detail: `Real cache stats: ${stats.entries} entries, ${stats.totalHits} hits, ~${stats.estTokensSaved} tokens served from local disk instead of the model (estimated from actual cached answer sizes). Persists in .aicache/ across VS Code windows and AI-tool sessions — a hit here in a later session for a question stored earlier is expected behavior, not a bug.`,
  };
}

/**
 * Real MCP tool-call counts — but scoped only to this extension's own
 * bundled token-cache server (cache_lookup/cache_store). Calls to
 * codegraph_explore or any other tool run in processes this extension
 * doesn't instrument, so those can't be counted here without guessing.
 */
export function measureCacheCalls(strategies: StrategyState): Measurement {
  if (!strategies.semanticCache) {
    return { status: 'disabled', detail: 'Strategy disabled in current profile' };
  }
  const ws = primaryWorkspacePath();
  if (!ws) {
    return { status: 'no-data', detail: 'No workspace folder open' };
  }

  const counts = new CallLogStore(ws).counts();
  if (counts.lookups === 0 && counts.stores === 0) {
    return { status: 'no-data', detail: 'No token-cache MCP tool calls recorded yet for this workspace.' };
  }
  return {
    status: 'measured',
    detail: `Lifetime, this workspace: ${counts.lookups} cache_lookup call(s) (${counts.hits} hit / ${counts.misses} miss${counts.staleHits > 0 ? `, ${counts.staleHits} stale` : ''}), ${counts.stores} cache_store call(s). Covers only this extension's bundled token-cache MCP server — not CodeGraph or other tool calls, which run in processes this extension doesn't instrument.`,
  };
}
