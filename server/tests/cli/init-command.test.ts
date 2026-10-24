import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PackageName } from '../../src/packages/package-name.ts';

/**
 * `fluidcad init` and the project's `.gitignore` (the user, 2026-10-12),
 * and `fluidcad init --package` (ui-packages-plan N1), run as the user runs
 * them: the real `bin/fluidcad.js` in a child process, in a temp folder,
 * with HOME and FLUIDCAD_HOME in temp folders too (signed out of the hub
 * unless a test writes its `credentials.json`; FLUIDCAD_HUB_TOKEN is
 * cleared and FLUIDCAD_HUB_URL names a hub nothing contacts). The CLI
 * imports the compiled server out of `server/dist`: run
 * `npm run build:server` after a server change.
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const ENGINE = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version as string;
const HUB = 'http://hub.test';

/** What `fluidcad init` has always written, byte for byte. */
const INIT_JS = "import { init } from 'fluidcad'\n\nexport default await init()\n";
const PART_JS = "import { part } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n});\n";
const JSCONFIG = '{\n  "compilerOptions": {\n    "checkJs": true,\n    "module": "node20",\n    "maxNodeModuleJsDepth": 8\n  }\n}\n';
const GITIGNORE = '.fluidcad/\n';

const LAYOUT_LINE =
  'Put the package\'s feature modules in features/, its parts in parts/ and its assemblies in assemblies/: ' +
  'the package exports what those folders hold.';

type Run = { status: number | null; stdout: string; stderr: string };

let tmp: string;
let project: string;

function init(cwd: string, args: string[] = []): Promise<Run> {
  const home = path.join(tmp, 'home');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, FLUIDCAD_HOME: path.join(tmp, 'fluidcad-home'), FLUIDCAD_HUB_URL: HUB };
  delete env.FLUIDCAD_HUB_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'init', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A stored credential for the test hub, as `fluidcad login` leaves it. */
function signIn(handle: string): void {
  const home = path.join(tmp, 'fluidcad-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ hubs: { [HUB]: { token: 'fch_stored', tokenId: 't1', handle, email: 'acme@example.com' } } }, null, 2), { mode: 0o600 });
}

const read = (rel: string) => fs.readFileSync(path.join(project, rel), 'utf8');
const gitignore = () => read('.gitignore');

/** Every entry under the project, project-relative POSIX, empty folders with a trailing slash, sorted. */
function tree(dir = project, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      const inside = tree(path.join(dir, entry.name), `${rel}/`);
      if (inside.length === 0) {
        out.push(`${rel}/`);
      } else {
        out.push(...inside);
      }
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-init-')));
  project = path.join(tmp, 'project');
  fs.mkdirSync(project);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fluidcad init and .gitignore', () => {
  it('writes a .gitignore with .fluidcad/ beside the scaffold when the folder has none', async () => {
    const run = await init(project);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('FluidCAD initialized.\n');
    expect(fs.readdirSync(project).sort()).toEqual(['.gitignore', 'fluidcad.json', 'init.js', 'jsconfig.json', 'part1.part.js']);
    expect(gitignore()).toBe('.fluidcad/\n');
  });

  it("appends .fluidcad/ to the project's own .gitignore and changes nothing else in it", async () => {
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n*.stl');
    const run = await init(project);
    expect(run.status).toBe(0);
    expect(gitignore()).toBe('node_modules/\n*.stl\n.fluidcad/\n');
  });

  it('leaves a .gitignore that already has it exactly as it was', async () => {
    fs.writeFileSync(path.join(project, '.gitignore'), '# mine\n.fluidcad/\ndist/\n');
    const run = await init(project);
    expect(run.status).toBe(0);
    expect(gitignore()).toBe('# mine\n.fluidcad/\ndist/\n');
  });

  it('touches nothing when the folder is already a project (init.js exists)', async () => {
    fs.writeFileSync(path.join(project, 'init.js'), 'mine');
    const run = await init(project);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('init.js already exists in this directory.\n');
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
  });
});

describe('fluidcad init writes what it always has', () => {
  it('byte for byte: the five files of a plain project, the engine pinned, no unit', async () => {
    const run = await init(project);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('FluidCAD initialized.\n');
    expect(tree()).toEqual(['.gitignore', 'fluidcad.json', 'init.js', 'jsconfig.json', 'part1.part.js']);
    expect(read('init.js')).toBe(INIT_JS);
    expect(read('part1.part.js')).toBe(PART_JS);
    expect(read('jsconfig.json')).toBe(JSCONFIG);
    expect(read('.gitignore')).toBe(GITIGNORE);
    expect(read('fluidcad.json')).toBe(`{\n  "engine": "${ENGINE}"\n}\n`);
  });

  it('--unit in writes the unit after the pin, and nothing else changes', async () => {
    const run = await init(project, ['--unit', 'in']);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('FluidCAD initialized.\n');
    expect(read('fluidcad.json')).toBe(`{\n  "engine": "${ENGINE}",\n  "unit": "in"\n}\n`);
    expect(read('part1.part.js')).toBe(PART_JS);
  });

  it('refuses an unknown unit before writing anything', async () => {
    const run = await init(project, ['--unit', 'furlong']);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe("Unknown length unit 'furlong'. Use one of: mm, cm, m, in, ft.\n");
    expect(tree()).toEqual([]);
  });
});

describe('fluidcad init --package', () => {
  it('scaffolds a package workspace: the project files in the layout, the README, the block, and prints what it wrote', async () => {
    const run = await init(project, ['--package', '@acme/kit']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      [
        'FluidCAD package @acme/kit 1.0.0 initialized:',
        '  init.js',
        '  fluidcad.json',
        '  parts/part1.part.js',
        '  features/',
        '  assemblies/',
        '  README.md',
        '  jsconfig.json',
        '  .gitignore',
        LAYOUT_LINE,
        '',
      ].join('\n'),
    );
    expect(tree()).toEqual(['.gitignore', 'README.md', 'assemblies/', 'features/', 'fluidcad.json', 'init.js', 'jsconfig.json', 'parts/part1.part.js']);
    expect(read('init.js')).toBe(INIT_JS);
    expect(read('parts/part1.part.js')).toBe(PART_JS);
    expect(read('jsconfig.json')).toBe(JSCONFIG);
    expect(read('.gitignore')).toBe(GITIGNORE);
    expect(read('README.md')).toBe('# @acme/kit\n');
    expect(JSON.parse(read('fluidcad.json'))).toEqual({ engine: ENGINE, package: { name: '@acme/kit', version: '1.0.0' } });
  });

  it('takes --unit too, between the pin and the block', async () => {
    const run = await init(project, ['--package', '@acme/kit', '--unit', 'in']);

    expect(run.status).toBe(0);
    expect(read('fluidcad.json')).toBe(`{\n  "engine": "${ENGINE}",\n  "unit": "in",\n  "package": {\n    "name": "@acme/kit",\n    "version": "1.0.0"\n  }\n}\n`);
  });

  it('signed out, refuses a name without its scope, saying to add the hub handle, and writes nothing', async () => {
    const run = await init(project, ['--package', 'kit']);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe('"name" "kit" needs your hub handle as its scope: write "@<your-handle>/kit".\n');
    expect(tree()).toEqual([]);
  });

  it('signed in, scopes a name without one with the stored handle and says so', async () => {
    signIn('acme');
    const run = await init(project, ['--package', 'kit']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.startsWith(`Named it @acme/kit: your handle on ${HUB}.\nFluidCAD package @acme/kit 1.0.0 initialized:\n`)).toBe(true);
    expect(JSON.parse(read('fluidcad.json')).package).toEqual({ name: '@acme/kit', version: '1.0.0' });
    expect(read('README.md')).toBe('# @acme/kit\n');
  });

  it('refuses a bad name with the rule before writing anything', async () => {
    const run = await init(project, ['--package', '@acme/3d-kit']);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`"@acme/3d-kit" is not a package name: ${PackageName.RULE}.\n`);
    expect(tree()).toEqual([]);
  });

  it('refuses a folder that is not empty, and writes nothing', async () => {
    fs.writeFileSync(path.join(project, 'part1.part.js'), 'mine');
    const run = await init(project, ['--package', '@acme/kit']);

    expect(run.status).toBe(1);
    expect(run.stderr).toBe('This directory is not empty (part1.part.js). A new package needs an empty directory.\n');
    expect(tree()).toEqual(['part1.part.js']);
    expect(read('part1.part.js')).toBe('mine');
  });

  it('lets a .gitignore be there, and gains the line in it', async () => {
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n');
    const run = await init(project, ['--package', '@acme/kit']);

    expect(run.status).toBe(0);
    expect(gitignore()).toBe('node_modules/\n.fluidcad/\n');
  });
});
