import * as assert from 'assert';
import * as path from 'path';
import {
  lookupCommand,
  needsShell,
  canRunShellScript,
  quoteWindowsArg,
  runTool,
} from '../../src/installer/platform';

/**
 * Measured on Windows 11 with rtk 0.49.0 and @colbymchenry/codegraph 1.6.0 both
 * installed and on PATH:
 *
 *   execSync('which rtk')                 FAIL  'which' is not recognized
 *   execSync('where rtk')                 OK    C:\\Users\\…\\.local\\bin\\rtk.exe
 *   spawnSync('npm', […])   no shell      FAIL  ENOENT
 *   spawnSync('npm', […])   shell: true   OK    11.4.2
 *   spawnSync('sh', ['-c', …])            FAIL  ENOENT (no POSIX shell)
 */
suite('Installer platform rules', () => {
  suite('lookupCommand', () => {
    test('uses where on Windows, because which does not exist there', () => {
      assert.strictEqual(lookupCommand('rtk', 'win32'), 'where rtk');
    });

    test('uses which everywhere else', () => {
      assert.strictEqual(lookupCommand('rtk', 'darwin'), 'which rtk');
      assert.strictEqual(lookupCommand('rtk', 'linux'), 'which rtk');
    });

    test('passes the binary name through unchanged', () => {
      assert.strictEqual(lookupCommand('codegraph', 'win32'), 'where codegraph');
      assert.strictEqual(lookupCommand('codegraph', 'linux'), 'which codegraph');
    });
  });

  suite('needsShell', () => {
    test('is true on Windows, where npm and codegraph are .cmd shims', () => {
      assert.strictEqual(needsShell('win32'), true);
    });

    test('is false elsewhere, so arguments stay escaped', () => {
      assert.strictEqual(needsShell('darwin'), false);
      assert.strictEqual(needsShell('linux'), false);
    });
  });

  suite('canRunShellScript', () => {
    test('is false on Windows: no sh to pipe curl into', () => {
      assert.strictEqual(canRunShellScript('win32'), false);
    });

    test('is true on macOS and Linux', () => {
      assert.strictEqual(canRunShellScript('darwin'), true);
      assert.strictEqual(canRunShellScript('linux'), true);
    });
  });

  suite('quoteWindowsArg', () => {
    // `shell: true` concatenates instead of escaping (DEP0190), so quoting is
    // part of using a shell at all: `C:\\Program Files\\x` would otherwise
    // arrive as two arguments.
    test('quotes anything containing whitespace', () => {
      assert.strictEqual(quoteWindowsArg('C:\\Program Files\\proj'), '"C:\\Program Files\\proj"');
    });

    test('leaves ordinary arguments alone', () => {
      assert.strictEqual(quoteWindowsArg('status'), 'status');
      assert.strictEqual(quoteWindowsArg('--format'), '--format');
    });

    test('escapes embedded quotes', () => {
      assert.strictEqual(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
    });

    test('quotes cmd metacharacters even without whitespace', () => {
      // Found by the runTool test below: `console.log(process.argv[1])` has no
      // space, but cmd.exe acts on the parentheses and the child never sees it.
      assert.strictEqual(
        quoteWindowsArg('console.log(process.argv[1])'),
        '"console.log(process.argv[1])"'
      );
      assert.strictEqual(quoteWindowsArg('a&b'), '"a&b"');
    });

    test('preserves an empty argument', () => {
      assert.strictEqual(quoteWindowsArg(''), '""');
    });
  });

  suite('runTool', () => {
    // Runs a real child process, because the point of the helper is that the
    // child actually starts. `node` exists wherever these tests do.
    test('runs a command and returns its output', () => {
      const r = runTool(process.execPath, ['-e', 'console.log("ran")'], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.strictEqual(r.error, undefined, `spawn failed: ${r.error?.message}`);
      assert.strictEqual((r.stdout ?? '').trim(), 'ran');
    });

    test('an argument containing spaces survives the shell', () => {
      // The regression this guards: with shell: true and no quoting, a path
      // with a space arrives as two arguments and the tool reads the wrong one.
      const spaced = path.join('C:', 'Program Files', 'a b', 'c.txt');
      const r = runTool(process.execPath, ['-e', 'console.log(process.argv[1])', spaced], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.strictEqual(r.error, undefined, `spawn failed: ${r.error?.message}`);
      assert.strictEqual((r.stdout ?? '').trim(), spaced);
    });
  });
});
