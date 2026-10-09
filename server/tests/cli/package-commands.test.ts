import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `fluidcad package init` and `fluidcad version`, run as the user runs
 * them: the real `bin/fluidcad.js` in a child process. The CLI imports the
 * compiled server out of `server/dist`, so these need `npm run build:server`
 * after a server change — the rules themselves are covered against the
 * sources in `server/tests/packages/package-authoring.test.ts`.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'packages', 'package-authoring.js');

let workspace: string;
let library: string;

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    // Nothing here touches the user library; point it at a temp directory anyway.
    env: { ...process.env, FLUIDCAD_PACKAGES: library },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function write(rel: string, contents = ''): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8'));
}

beforeAll(() => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
});

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-package-'));
  library = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-library-'));
  write('fluidcad.json', JSON.stringify({ engine: '0.0.46', unit: 'in' }, null, 2) + '\n');
  write('init.js');
  write('standoff.feature.js');
  write('features/boss.feature.js');
  write('plate.part.js');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(library, { recursive: true, force: true });
});

describe('fluidcad package init', () => {
  it('writes the block with version 0.1.0 and the feature modules, and prints it', () => {
    const run = cli('package', 'init', '--name', '@acme/demo');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const block = { name: '@acme/demo', version: '0.1.0', exports: ['features/boss.feature.js', 'standoff.feature.js'] };
    expect(readConfig()).toEqual({ engine: '0.0.46', unit: 'in', package: block });
    expect(run.stdout).toContain('Wrote the "package" block to');
    expect(run.stdout).toContain(JSON.stringify(block, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
    // Nothing reached the library.
    expect(fs.readdirSync(library)).toEqual([]);
  });

  it('takes the workspace from --workspace', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-cli-cwd-'));
    try {
      const result = spawnSync(process.execPath, [CLI, 'package', 'init', '-n', '@acme/demo', '-w', workspace], {
        cwd: elsewhere, encoding: 'utf8', env: { ...process.env, FLUIDCAD_PACKAGES: library },
      });
      expect(result.status).toBe(0);
      expect(readConfig().package.name).toBe('@acme/demo');
      expect(fs.existsSync(path.join(elsewhere, 'fluidcad.json'))).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a bad name with exit 1 and leaves the file alone', () => {
    const run = cli('package', 'init', '--name', 'demo');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"demo" is not a package name');
    expect(readConfig()).toEqual({ engine: '0.0.46', unit: 'in' });
  });

  it('asks for --name when there is no terminal to prompt on', () => {
    const run = cli('package', 'init');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--name @scope/name');
    expect(readConfig().package).toBeUndefined();
  });

  it('refuses a workspace that is already a package', () => {
    expect(cli('package', 'init', '--name', '@acme/demo').status).toBe(0);

    const run = cli('package', 'init', '--name', '@acme/other');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('already the package @acme/demo 0.1.0');
    expect(readConfig().package.name).toBe('@acme/demo');
  });
});

describe('fluidcad version', () => {
  it('bumps patch, minor and major, and sets an exact version, printing each change', () => {
    expect(cli('package', 'init', '--name', '@acme/demo').status).toBe(0);

    const steps: [string, string][] = [
      ['patch', '@acme/demo 0.1.0 → 0.1.1'],
      ['minor', '@acme/demo 0.1.1 → 0.2.0'],
      ['major', '@acme/demo 0.2.0 → 1.0.0'],
      ['1.1.0-beta.1', '@acme/demo 1.0.0 → 1.1.0-beta.1'],
      ['minor', '@acme/demo 1.1.0-beta.1 → 1.1.0'],
    ];
    for (const [spec, printed] of steps) {
      const run = cli('version', spec);
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(printed);
    }

    const config = readConfig();
    expect(config.package.version).toBe('1.1.0');
    expect(config).toMatchObject({ engine: '0.0.46', unit: 'in' });
    expect(config.package.exports).toEqual(['features/boss.feature.js', 'standoff.feature.js']);
  });

  it('refuses outside a package', () => {
    const run = cli('version', 'patch');

    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe("This workspace isn't a package — run `fluidcad package init` first.");
  });

  it('refuses a spec that is neither a bump nor a version', () => {
    expect(cli('package', 'init', '--name', '@acme/demo').status).toBe(0);

    const run = cli('version', '1.2');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"1.2" is not a version or a bump');
    expect(readConfig().package.version).toBe('0.1.0');
  });

  it('needs the bump argument', () => {
    const run = cli('version');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("missing required argument 'bump'");
  });
});
