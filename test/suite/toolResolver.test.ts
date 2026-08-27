import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The resolver is what makes Windows work: `which` does not exist there, npm
// CLIs are .cmd shims that cannot be spawned directly, and VS Code frequently
// runs with a PATH that predates the tool's install.
suite('Tool resolver (cross-platform binary detection)', () => {
  const isWindows = process.platform === 'win32';
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-token-resolver-test-'));
  });

  teardown(() => {
    const { setToolPathOverrides } = require('../../src/installer/toolResolver');
    setToolPathOverrides({});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Creates an executable stub the resolver should be able to find. */
  function writeFakeBinary(dir: string, baseName: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, isWindows ? `${baseName}.cmd` : baseName);
    fs.writeFileSync(file, isWindows ? '@echo off\r\necho stub\r\n' : '#!/bin/sh\necho stub\n', 'utf-8');
    if (!isWindows) { fs.chmodSync(file, 0o755); }
    return file;
  }

  test('finds a binary that is on PATH without shelling out to which/where', () => {
    const { resolveTool, isBinaryAvailable } = require('../../src/installer/toolResolver');
    const node = resolveTool('node');
    assert.ok(node, 'node should always be resolvable inside the test host');
    assert.ok(path.isAbsolute(node.path), `expected an absolute path, got ${node.path}`);
    assert.ok(fs.existsSync(node.path));
    assert.ok(isBinaryAvailable('node'));
  });

  test('returns null for a binary that does not exist anywhere', () => {
    const { resolveTool, isBinaryAvailable } = require('../../src/installer/toolResolver');
    assert.strictEqual(resolveTool('definitely-not-a-real-binary-xyz'), null);
    assert.strictEqual(isBinaryAvailable('definitely-not-a-real-binary-xyz'), false);
  });

  test('an explicit toolPaths override wins over PATH', () => {
    const { setToolPathOverrides, resolveTool } = require('../../src/installer/toolResolver');
    const stub = writeFakeBinary(tmpDir, 'codegraph');

    setToolPathOverrides({ codegraph: stub });

    const resolved = resolveTool('codegraph');
    assert.ok(resolved);
    assert.strictEqual(resolved.path, stub);
    assert.strictEqual(resolved.source, 'override');
  });

  test('a directory override is searched for the binary (platform extensions included)', () => {
    const { setToolPathOverrides, resolveTool } = require('../../src/installer/toolResolver');
    const stub = writeFakeBinary(tmpDir, 'rtk');

    setToolPathOverrides({ rtk: tmpDir });

    const resolved = resolveTool('rtk');
    assert.ok(resolved, 'directory override should locate the executable inside it');
    assert.strictEqual(resolved.path, stub);
  });

  test('a bad override does not mask a working PATH install', () => {
    const { setToolPathOverrides, resolveTool } = require('../../src/installer/toolResolver');
    setToolPathOverrides({ node: path.join(tmpDir, 'nope', 'node') });

    const resolved = resolveTool('node');
    assert.ok(resolved, 'should fall back to PATH when the override points nowhere');
    assert.strictEqual(resolved.source, 'path');
  });

  test('changing overrides invalidates the memoized resolution', () => {
    const { setToolPathOverrides, resolveTool } = require('../../src/installer/toolResolver');
    const first = writeFakeBinary(path.join(tmpDir, 'a'), 'codegraph');
    const second = writeFakeBinary(path.join(tmpDir, 'b'), 'codegraph');

    setToolPathOverrides({ codegraph: first });
    assert.strictEqual(resolveTool('codegraph').path, first);

    setToolPathOverrides({ codegraph: second });
    assert.strictEqual(resolveTool('codegraph').path, second);
  });

  test('runTool executes a resolved binary and captures stdout', () => {
    const { runTool, ranOk } = require('../../src/installer/toolResolver');
    const result = runTool('node', ['-e', 'process.stdout.write("hello")'], { timeoutMs: 10000 });
    assert.ok(ranOk(result), `node did not run cleanly: ${result.error?.message ?? result.stderr}`);
    assert.strictEqual(result.stdout.trim(), 'hello');
  });

  test('runTool reports a missing binary as an error result instead of throwing', () => {
    const { runTool, ranOk } = require('../../src/installer/toolResolver');
    const result = runTool('definitely-not-a-real-binary-xyz', ['--version']);
    assert.strictEqual(ranOk(result), false);
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /toolPaths/);
  });

  test('a .cmd shim is flagged for the cmd.exe wrapper (Windows only)', function () {
    if (!isWindows) { this.skip(); }
    const { setToolPathOverrides, resolveTool, mcpCommandFor } = require('../../src/installer/toolResolver');
    const stub = writeFakeBinary(tmpDir, 'codegraph');

    setToolPathOverrides({ codegraph: stub });

    assert.strictEqual(resolveTool('codegraph').needsShell, true);
    const spec = mcpCommandFor('codegraph', ['mcp']);
    assert.ok(/cmd(\.exe)?$/i.test(spec.command), `expected a cmd.exe wrapper, got ${spec.command}`);
    assert.deepStrictEqual(spec.args, ['/c', stub, 'mcp']);
  });

  // These two cover the Windows-only branches from any platform: the shim
  // handling is what makes an npm-installed codegraph usable there at all.
  test('a shim tool is launched through cmd.exe with a quoted command line', () => {
    const { cmdInvocation } = require('../../src/installer/toolResolver');
    const argv = cmdInvocation('C:\\Program Files\\npm\\codegraph.cmd', ['status']);
    assert.deepStrictEqual(argv.slice(0, 3), ['/d', '/s', '/c']);
    assert.strictEqual(argv[3], '"\"C:\\Program Files\\npm\\codegraph.cmd\" status"');
  });

  test('a shim MCP entry is wrapped in cmd /c instead of naming the .cmd directly', () => {
    const { toMcpSpec } = require('../../src/installer/toolResolver');
    const shim = {
      name: 'codegraph',
      path: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codegraph.cmd',
      dir: 'C:\\Users\\dev\\AppData\\Roaming\\npm',
      source: 'known-dir',
      needsShell: true,
    };
    const spec = toMcpSpec(shim, ['mcp']);
    assert.ok(/cmd(\.exe)?$/i.test(spec.command), `expected cmd.exe, got ${spec.command}`);
    assert.deepStrictEqual(spec.args, ['/c', shim.path, 'mcp']);

    const exe = { ...shim, path: 'C:\\tools\\rtk.exe', needsShell: false };
    assert.deepStrictEqual(toMcpSpec(exe, ['mcp']), { command: 'C:\\tools\\rtk.exe', args: ['mcp'] });
  });

  test('mcpCommandFor keeps a PATH tool bare on POSIX but absolute on Windows', () => {
    const { mcpCommandFor } = require('../../src/installer/toolResolver');
    const spec = mcpCommandFor('node', ['--version']);
    assert.ok(spec);
    assert.deepStrictEqual(spec.args.slice(-1), ['--version']);
    if (isWindows) {
      assert.ok(path.isAbsolute(spec.command), 'Windows entries must not rely on PATH');
    } else {
      // Hard-coding an nvm-versioned path here would break on the next switch.
      assert.strictEqual(spec.command, 'node');
    }
  });

  test('a tool found outside PATH is always written as an absolute MCP command', () => {
    const { setToolPathOverrides, mcpCommandFor } = require('../../src/installer/toolResolver');
    const stub = writeFakeBinary(tmpDir, 'codegraph');
    setToolPathOverrides({ codegraph: stub });

    const spec = mcpCommandFor('codegraph', ['mcp']);
    assert.ok(spec);
    if (isWindows) {
      assert.deepStrictEqual(spec.args, ['/c', stub, 'mcp']);
    } else {
      assert.strictEqual(spec.command, stub);
    }
  });

  test('mcpCommandFor returns null when the tool cannot be found', () => {
    const { mcpCommandFor } = require('../../src/installer/toolResolver');
    assert.strictEqual(mcpCommandFor('definitely-not-a-real-binary-xyz', []), null);
  });

  test('pathStartsWith matches case-insensitively on Windows only', () => {
    const { pathStartsWith } = require('../../src/installer/toolResolver');
    const parent = path.join(tmpDir, 'repo');
    const child = path.join(parent, 'src', 'index.ts');

    assert.strictEqual(pathStartsWith(child, parent), true);
    assert.strictEqual(pathStartsWith(parent, parent), true);
    assert.strictEqual(pathStartsWith(path.join(tmpDir, 'repo-other', 'f.ts'), parent), false);
    assert.strictEqual(pathStartsWith(child.toUpperCase(), parent.toUpperCase()), true);
  });

  test('known install directories include the platform locations tools actually land in', () => {
    const { knownInstallDirs, managedBinDir } = require('../../src/installer/toolResolver');
    const dirs: string[] = knownInstallDirs().map((d: string) => d.toLowerCase());

    assert.ok(dirs.includes(managedBinDir().toLowerCase()));
    if (isWindows) {
      // npm -g default on Windows — the single most common "installed but
      // invisible to VS Code" location.
      assert.ok(dirs.some(d => d.endsWith(path.join('appdata', 'roaming', 'npm'))) || dirs.some(d => d.endsWith(path.sep + 'npm')));
      assert.ok(dirs.some(d => d.includes('.cargo')));
    } else {
      assert.ok(dirs.includes('/usr/local/bin'));
      assert.ok(dirs.includes('/opt/homebrew/bin'));
    }
  });
});
