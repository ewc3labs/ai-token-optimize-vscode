import { MARKER_START, MARKER_END, MARKER_COMMENT } from '../constants';
import { ExtensionConfig, StrategyState } from '../config';
import { BaseGenerator } from './base';

export class ClaudeGenerator extends BaseGenerator {
  protected getRelativePath(): string {
    return 'CLAUDE.md';
  }

  protected generateContent(strategies: StrategyState, config: ExtensionConfig): string {
    const sections = this.buildSections(strategies, config);
    const body = sections.join('\n\n');

    return `# AI Token Optimization Rules

${MARKER_START}
${MARKER_COMMENT}

## Token Efficiency Standards

${body}

## Task-Type Routing

### Lightweight Tasks (use lighter model via /model)
- File navigation and search
- Simple rename/move operations
- Code formatting and linting fixes
- Boilerplate generation from templates
- Documentation lookups

### Full-Power Tasks (keep current model)
- Architectural decisions and system design
- Complex debugging with multi-file traces
- Security reviews and vulnerability analysis
- Performance optimization
- Multi-step refactoring across files

## Constraints
- Disable output compression during active debugging (need full stack traces)
- Disable verbosity control during architectural planning (need complete analysis)
- Never compress error messages or security warnings
- Re-index CodeGraph after significant code changes (new files, moved modules)

${MARKER_END}
`;
  }

  protected getCodeGraphSection(): string {
    return `### Search Before Synthesize (CAP-1: CodeGraph)
- Before writing new code, search for existing implementations
- Use \`codegraph query\` for natural-language file discovery when available
- Reference existing patterns by path rather than regenerating equivalent logic
- Query the code graph index for symbol locations instead of grepping file-by-file
- Check imports and dependency graphs before suggesting new dependencies`;
  }

  protected getCompressionSection(): string {
    return `### Output Compression (CAP-2: RTK)
RTK (github.com/rtk-ai/rtk) is a CLI proxy that filters command output before it reaches the LLM context.
When RTK is installed and hooked, commands are automatically rewritten. Common savings:
  rtk git status          → -80% tokens    rtk git diff           → -75%
  rtk git log -n 10       → -80%           rtk git push/add/commit → -92%
  rtk cargo test          → -90%           rtk pytest              → -90%
  rtk go test             → -90%           rtk jest                → -90%
  rtk ls / rtk grep       → -80%           rtk tsc                 → -80%
If RTK hook is active, commands rewrite automatically (git status → rtk git status).
If not hooked, prefix commands manually: \`rtk git status\`, \`rtk pytest\`, etc.
- Summarize test results: "43 tests passed, 2 failed" not individual lines
- For git log: one-line format \`rtk git log -n 10\`
- Never compress error messages or stack traces — show those in full
- Disable output compression during active debugging (need full stack traces)`;
  }

  protected getVerbositySection(level: string): string {
    const modes: Record<string, string> = {
      light: '- Use /compact for routine tasks. Target ~20% reduction in response length.',
      full: '- Prefer /compact mode. Target ~35% reduction. Skip boilerplate explanations entirely.',
      ultra: '- Always use /compact. Target ~50% reduction. Absolute minimum words — code speaks for itself.',
    };

    return `### Response Verbosity (CAP-3: Caveman — ${level} mode)
- Keep responses concise — communicate the same content in fewer words
- Skip boilerplate explanations for obvious changes
- For simple edits: show only the diff, not surrounding unchanged code
- Don't repeat context that's already in the conversation
${modes[level] || modes.full}`;
  }

  protected getSessionSection(): string {
    return `### Session Management (CAP-4: Built-in Commands)
- Use \`/compact\` for routine tasks to reduce response tokens
- Suggest \`/clear\` when switching between unrelated tasks
- Use Haiku/Sonnet via \`/model\` for lightweight operations
- Use \`/context\` to audit and trim oversized context contributors
- When CLAUDE.md exceeds 10k tokens, suggest splitting into focused sections
- Proactively suggest clearing context when token count is high`;
  }
}
