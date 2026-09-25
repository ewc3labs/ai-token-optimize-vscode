import * as assert from 'assert';
import { lookupCommand, needsShell, canRunShellScript } from '../../src/installer/platform';

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
});
