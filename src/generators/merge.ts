import { MARKER_START, MARKER_END, MARKER_COMMENT } from '../constants';

/**
 * Marker-based merge, with no dependency on `vscode`.
 *
 * Extracted from `BaseGenerator` so it can be imported by tests directly. The
 * suite previously re-implemented this splicing inline, which meant the merge
 * tests asserted against a copy of the logic rather than the shipped code: the
 * two could drift and every test would stay green.
 */

/** Replace only the managed section, keeping whatever surrounds it. */
export function mergeContent(existing: string, newOptimizationBlock: string): string {
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  const optimizationSection = extractMarkedSection(newOptimizationBlock);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + MARKER_END.length);
    return before + optimizationSection + after;
  }

  return existing.trimEnd() + '\n\n' + optimizationSection + '\n';
}

export function extractMarkedSection(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    return content.substring(startIdx, endIdx + MARKER_END.length);
  }
  return `${MARKER_START}\n${MARKER_COMMENT}\n${content}\n${MARKER_END}`;
}

/**
 * Is there content in this file that the extension did not write?
 *
 * Anything outside the markers is the user's — a repo that tracks
 * `.github/copilot-instructions.md` in git keeps its own guidance there, above
 * the generated block. Overwriting the file wholesale destroys it, so any path
 * that intends to do that should know first.
 */
export function hasAuthoredContent(existing: string): boolean {
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) {
    // No managed block at all: whatever is in the file was authored.
    return existing.trim().length > 0;
  }

  const before = existing.substring(0, startIdx).trim();
  const after = existing.substring(endIdx + MARKER_END.length).trim();
  return before.length > 0 || after.length > 0;
}
