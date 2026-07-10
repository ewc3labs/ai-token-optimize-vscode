import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import { StrategyState } from '../config';
import { isBinaryAvailable } from '../installer/installer';
import { getProjectsToIndex } from '../ui/projectPicker';

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
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf-8', cwd });
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), ok: r.status === 0 && !r.error };
}

function primaryWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * CAP-2: run the same two read-only, bounded commands raw and through `rtk`
 * on this workspace, and diff the actual byte counts. Bounded to maxdepth 1
 * so it stays fast and safe regardless of repo size (never descends into
 * node_modules — only lists it as a single, unexpanded entry).
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

  const rawLs = run('ls', ['-la', ws]);
  const rtkLs = run('rtk', ['ls', ws]);
  const rawFind = run('find', [ws, '-maxdepth', '1', '-type', 'f']);
  const rtkFind = run('rtk', ['find', ws, '-maxdepth', '1', '-type', 'f']);

  const pairs: Array<{ raw: string; opt: string }> = [];
  if (rawLs.ok && rtkLs.ok && rawLs.out.length > 0) { pairs.push({ raw: rawLs.out, opt: rtkLs.out }); }
  if (rawFind.ok && rtkFind.ok && rawFind.out.length > 0) { pairs.push({ raw: rawFind.out, opt: rtkFind.out }); }

  if (pairs.length === 0) {
    return { status: 'no-data', detail: 'Live benchmark commands did not complete — try again or check the Output panel' };
  }

  const reductions = pairs.map(p => (1 - p.opt.length / p.raw.length) * 100);
  const avg = reductions.reduce((a, b) => a + b, 0) / reductions.length;

  return {
    status: 'measured',
    percent: Math.round(avg),
    detail: `Live benchmark, this workspace: 'ls -la' + 'find -maxdepth 1', raw vs. via rtk, byte-for-byte (${pairs.length}/2 commands compared). Reduction varies by command — a verbose grep can see 0%, a directory listing can see 80%+.`,
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
    detail: `Real index (queried now): ${totalFiles} files, ${totalNodes} symbols, ${totalEdges} edges across ${indexedCount}/${projects.length} project(s) — ${freshness}. Task-dependent in practice: a targeted "find callers" query measured 32% fewer bytes than grep; a broad "explore" query measured 2.6x more, since it pulls related files for context. No single percentage is honest here — the index stats above are what's real for this workspace right now.`,
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
