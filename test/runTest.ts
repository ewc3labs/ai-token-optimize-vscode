import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Pinned: @vscode/test-electron 2.5.2 still looks for
    // "Visual Studio Code.app/Contents/MacOS/Electron", but VS Code renamed
    // that binary to "Code" in recent releases, so `stable` fails to launch on
    // macOS. Override with VSCODE_TEST_VERSION once the harness catches up.
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || '1.85.0',
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
