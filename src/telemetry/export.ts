// Pure Node — serializes telemetry to portable formats. JSON/CSV/Markdown are
// produced natively (no runtime deps). Excel and PDF are intentionally omitted:
// both require third-party libraries this extension forbids, and CSV opens
// directly in Excel/Sheets, while Markdown covers the report use case.
import { RepositoryMetrics, SavingsEstimate } from './types';
import { HistoryRow } from './store';

export type ExportFormat = 'json' | 'csv' | 'markdown';

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  json: 'json',
  csv: 'csv',
  markdown: 'md',
};

export interface ExportInput {
  generatedAt: number;
  repositories: RepositoryMetrics[];
  estimates: SavingsEstimate[];
  history: HistoryRow[];
}

export function exportTelemetry(input: ExportInput, format: ExportFormat): string {
  switch (format) {
    case 'json': return toJson(input);
    case 'csv': return toCsv(input);
    case 'markdown': return toMarkdown(input);
  }
}

function toJson(input: ExportInput): string {
  return JSON.stringify(
    {
      generatedAt: new Date(input.generatedAt).toISOString(),
      note: 'Repository metrics are read from the CodeGraph index (real). Savings estimates are modeled — this extension is not in the LLM request path.',
      repositories: input.repositories,
      savingsEstimates: input.estimates,
      history: input.history,
    },
    null,
    2,
  );
}

/** CSV escaping: wrap in quotes and double any embedded quote. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * CSV export focuses on the history rows (the time series), which is the shape
 * that belongs in a spreadsheet. A trailing section lists the current snapshot.
 */
function toCsv(input: ExportInput): string {
  const lines: string[] = [];
  lines.push('# History (repository growth over time)');
  lines.push(csvRow(['timestamp_iso', 'repository', 'files', 'nodes', 'edges', 'classes', 'interfaces', 'methods', 'functions', 'index_bytes']));
  for (const r of input.history) {
    lines.push(csvRow([new Date(r.t).toISOString(), r.repo, r.files, r.nodes, r.edges, r.classes, r.interfaces, r.methods, r.functions, r.indexBytes]));
  }
  lines.push('');
  lines.push('# Current snapshot (real) + modeled savings');
  lines.push(csvRow(['repository', 'files', 'directories', 'classes', 'interfaces', 'enums', 'methods', 'functions', 'nodes', 'edges', 'index_bytes', 'source_bytes', 'est_token_reduction_pct', 'est_cost_saved_usd_per_query']));
  input.repositories.forEach((repo, i) => {
    const e = input.estimates[i];
    lines.push(csvRow([repo.repositoryName, repo.totalFiles, repo.totalDirectories, repo.totalClasses, repo.totalInterfaces, repo.totalEnums, repo.totalMethods, repo.totalFunctions, repo.totalGraphNodes, repo.totalGraphRelationships, repo.indexSizeBytes, repo.sourceBytes, e?.tokenReductionPercent ?? '', e?.estimatedCostSavedUsd ?? '']));
  });
  return lines.join('\n') + '\n';
}

function toMarkdown(input: ExportInput): string {
  const out: string[] = [];
  out.push('# AI Token Optimizer — Telemetry Report');
  out.push('');
  out.push(`_Generated ${new Date(input.generatedAt).toISOString()}_`);
  out.push('');
  out.push('> Repository metrics below are **real** (read from the CodeGraph index). Savings are a **modeled estimate** — this extension is not in the LLM request path, so real per-request token counts are not observed.');
  out.push('');

  input.repositories.forEach((repo, i) => {
    const e = input.estimates[i];
    out.push(`## ${repo.repositoryName}`);
    out.push('');
    out.push('### Repository Intelligence (real)');
    out.push('');
    out.push('| Metric | Value |');
    out.push('| --- | ---: |');
    out.push(`| Files | ${repo.totalFiles.toLocaleString()} |`);
    out.push(`| Directories | ${repo.totalDirectories.toLocaleString()} |`);
    out.push(`| Classes | ${repo.totalClasses.toLocaleString()} |`);
    out.push(`| Interfaces | ${repo.totalInterfaces.toLocaleString()} |`);
    out.push(`| Enums | ${repo.totalEnums.toLocaleString()} |`);
    out.push(`| Methods | ${repo.totalMethods.toLocaleString()} |`);
    out.push(`| Functions | ${repo.totalFunctions.toLocaleString()} |`);
    out.push(`| Graph Nodes | ${repo.totalGraphNodes.toLocaleString()} |`);
    out.push(`| Relationships | ${repo.totalGraphRelationships.toLocaleString()} |`);
    out.push(`| Index Size (bytes) | ${repo.indexSizeBytes.toLocaleString()} |`);
    out.push('');
    if (e) {
      out.push('### Estimated Savings (modeled)');
      out.push('');
      out.push(`Assumptions: whole-repository baseline, ~${e.assumptions.avgFilesRetrievedPerQuery} files/query, ${e.assumptions.charsPerToken} chars/token, $${e.assumptions.usdPer1kPromptTokens}/1K prompt tokens.`);
      out.push('');
      out.push('| Metric | Without Graph | With Graph |');
      out.push('| --- | ---: | ---: |');
      out.push(`| Prompt tokens | ${e.estimatedPromptTokensWithoutGraph.toLocaleString()} | ${e.estimatedPromptTokensWithGraph.toLocaleString()} |`);
      out.push(`| Context (KB) | ${e.estimatedContextKbWithoutGraph} | ${e.estimatedContextKbWithGraph} |`);
      out.push(`| Cost (USD) | $${e.estimatedCostWithoutGraphUsd.toFixed(4)} | $${e.estimatedCostWithGraphUsd.toFixed(4)} |`);
      out.push('');
      out.push(`**Token reduction: ${e.tokenReductionPercent}% · Files reduction: ${e.filesReductionPercent}% · Est. cost saved/query: $${e.estimatedCostSavedUsd.toFixed(4)}**`);
      out.push('');
    }
  });

  if (input.history.length > 0) {
    out.push('## Repository Growth (history)');
    out.push('');
    out.push('| Timestamp | Repo | Files | Nodes | Edges | Index bytes |');
    out.push('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const r of input.history.slice(-50)) {
      out.push(`| ${new Date(r.t).toISOString()} | ${r.repo} | ${r.files} | ${r.nodes} | ${r.edges} | ${r.indexBytes.toLocaleString()} |`);
    }
    out.push('');
  }

  return out.join('\n');
}
