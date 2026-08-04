// Dependency-free reader for CodeGraph's SQLite index. The extension has no
// runtime dependencies (no better-sqlite3), so we shell out to the `sqlite3`
// CLI. Reads are strictly read-only and time-bounded; every caller degrades
// gracefully when sqlite3 is absent (see repositoryCollector's fallback).
import * as fs from 'fs';
import * as path from 'path';
import { ranOk, runTool } from '../installer/toolResolver';

/** Unit-separator record/field delimiters — safe against `|`/tab in data. */
const FS = '\x1f';
const RS = '\x1e';

export interface CodeGraphDbLocation {
  dbPath: string;
  indexSizeBytes: number;
}

/** Locates `<project>/.codegraph/codegraph.db` and its on-disk size, if present. */
export function locateDb(projectPath: string): CodeGraphDbLocation | null {
  const dbPath = path.join(projectPath, '.codegraph', 'codegraph.db');
  try {
    const stat = fs.statSync(dbPath);
    if (!stat.isFile() || stat.size === 0) { return null; }
    return { dbPath, indexSizeBytes: stat.size };
  } catch {
    return null;
  }
}

/** Whether the `sqlite3` CLI is invocable at all. */
export function isSqliteAvailable(): boolean {
  try {
    // Windows ships no sqlite3 by default — callers fall back to
    // `codegraph status` totals, so a false here is expected, not an error.
    return ranOk(runTool('sqlite3', ['-version'], { timeoutMs: 3000 }));
  } catch {
    return false;
  }
}

/**
 * Runs one read-only SQL statement and returns rows as string-cell arrays.
 * Opens the DB in immutable mode via a file: URI so a concurrent CodeGraph
 * daemon writing the same file can never be blocked or corrupted by our read.
 * Returns null on any failure (missing CLI, locked/corrupt db, timeout).
 */
export function query(dbPath: string, sql: string, timeoutMs = 5000): string[][] | null {
  // Backslashes are not legal in a sqlite file: URI — normalise Windows paths.
  const uri = `file:${dbPath.replace(/\\/g, '/')}?immutable=1`;
  const r = runTool(
    'sqlite3',
    ['-readonly', '-batch', '-noheader', '-nullvalue', '', '-separator', FS, '-newline', RS, uri, sql],
    { timeoutMs },
  );
  if (!ranOk(r)) { return null; }
  const out = r.stdout ?? '';
  // sqlite3 terminates every row (including the last) with the row separator,
  // so a naive split leaves a trailing empty record — drop empties.
  return out
    .split(RS)
    .filter((row) => row.length > 0)
    .map((row) => row.split(FS));
}

/** SELECT kind, COUNT(*) → { kind: count }. Empty object on failure. */
export function countBy(dbPath: string, table: 'nodes' | 'edges', column = 'kind'): Record<string, number> {
  const rows = query(dbPath, `SELECT ${column}, COUNT(*) FROM ${table} GROUP BY ${column};`);
  const out: Record<string, number> = {};
  for (const [key, count] of rows ?? []) {
    if (key !== undefined) { out[key] = Number(count) || 0; }
  }
  return out;
}
