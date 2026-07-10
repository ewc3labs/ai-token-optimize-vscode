import { MARKER_START, MARKER_END, MARKER_COMMENT } from '../constants';
import { ExtensionConfig, StrategyState } from '../config';
import { BaseGenerator } from './base';

export class CodexGenerator extends BaseGenerator {
  protected getRelativePath(): string {
    return '.codex/instructions.md';
  }

  protected generateContent(strategies: StrategyState, config: ExtensionConfig): string {
    const sections = this.buildSections(strategies, config);
    const body = sections.join('\n\n');

    return `# AI Token Optimization Guidelines

${MARKER_START}
${MARKER_COMMENT}

## Token Efficiency Standards

${body}

## Constraints
- Full verbosity for debugging sessions (need complete error context)
- Full detail for architectural planning (need thorough analysis)
- Never compress security-related output or error messages

${MARKER_END}
`;
  }

  protected getCodeGraphSection(): string {
    return `### Search Before Synthesize (CAP-1)
- Search existing codebase for similar patterns before generating new code
- Reference existing implementations by file path instead of duplicating logic
- Use indexed search when available for faster file discovery
- Check for existing utilities before creating new helper functions`;
  }

  protected getCompressionSection(): string {
    return `### Output Compression (CAP-2: RTK)
RTK (github.com/rtk-ai/rtk) filters CLI output for 60-90% token savings.
Use RTK commands directly or let the hook auto-rewrite:
  rtk git status / rtk git diff / rtk git log -n 10
  rtk cargo test / rtk pytest / rtk go test  (failures only, -90%)
  rtk ls / rtk grep / rtk read / rtk tsc
- Summarize CLI output: counts and status, not individual lines
- On test failure: show failing test names and assertion errors only
- On build error: show compiler error lines only, not full build log
- Never compress stack traces or error messages — show those in full`;
  }

  protected getVerbositySection(level: string): string {
    const guidance: Record<string, string> = {
      light: '- Target ~20% reduction in response length',
      full: '- Target ~35% reduction in response length',
      ultra: '- Target ~50% reduction — absolute minimum words',
    };

    return `### Response Conciseness (CAP-3 — ${level} mode)
- Keep responses brief and direct for routine code changes
- Show only modified code sections, not entire files
- Use bullet points over paragraphs
- Skip unnecessary preambles and summaries
${guidance[level] || guidance.full}`;
  }

  protected getSessionSection(): string {
    return `### Context Hygiene (CAP-4)
- Summarize completed task context before moving to new tasks
- Don't re-read recently accessed files in the same session
- Suggest context trimming when conversation grows large
- Use efficient model routing for simple vs complex tasks`;
  }
}
