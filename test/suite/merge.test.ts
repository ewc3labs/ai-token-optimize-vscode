import * as assert from 'assert';
import { mergeContent, hasAuthoredContent } from '../../src/generators/merge';
import { MARKER_START, MARKER_END } from '../../src/constants';

/**
 * These import the shipped merge code. The older "Content Merge Logic" suite in
 * extension.test.ts asserts against an inline re-implementation of the same
 * splicing, so it stays green even if the real merge changes underneath it.
 */
suite('Marker merge (shipped implementation)', () => {
  const block = (body: string): string => `${MARKER_START}\n${body}\n${MARKER_END}`;

  test('replaces the managed section and keeps everything around it', () => {
    const existing = `# Authored heading\n\nHand-written guidance.\n\n${block('old generated')}\n\n## Trailing authored section\n`;

    const merged = mergeContent(existing, block('new generated'));

    assert.ok(merged.includes('new generated'), 'the managed block must be refreshed');
    assert.ok(!merged.includes('old generated'), 'the previous block must be gone');
    assert.ok(merged.includes('Hand-written guidance.'), 'content before the markers must survive');
    assert.ok(
      merged.includes('## Trailing authored section'),
      'content after the markers must survive'
    );
  });

  test('appends the managed section to a file that has no markers', () => {
    const existing = '# My instructions\n\nDo this.\n';

    const merged = mergeContent(existing, block('generated'));

    assert.ok(merged.includes('My instructions'));
    assert.ok(merged.includes('generated'));
  });

  suite('hasAuthoredContent', () => {
    test('is false for a file that is only the managed block', () => {
      assert.strictEqual(hasAuthoredContent(`${block('generated')}\n`), false);
    });

    test('is true when something sits above the markers', () => {
      // The real case: a repo tracks .github/copilot-instructions.md and keeps
      // its own guidance above the generated block — for instance, the note
      // saying the tools the block names are optional on a fresh clone.
      const existing = `# Project instructions\n\nrtk is optional here.\n\n${block('generated')}\n`;
      assert.strictEqual(hasAuthoredContent(existing), true);
    });

    test('is true when something sits below the markers', () => {
      assert.strictEqual(hasAuthoredContent(`${block('generated')}\n\n## Appendix\n`), true);
    });

    test('is true for a file with no managed block at all', () => {
      assert.strictEqual(hasAuthoredContent('# Just mine\n'), true);
    });

    test('is false for an empty file', () => {
      assert.strictEqual(hasAuthoredContent(''), false);
      assert.strictEqual(hasAuthoredContent('\n  \n'), false);
    });
  });
});
