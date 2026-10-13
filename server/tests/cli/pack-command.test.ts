import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

/**
 * `fluidcad pack`, run as the user runs it: the real `bin/fluidcad.js` in a
 * child process, over a copy of fixtures/package-workspace. The CLI imports
 * the compiled server out of `server/dist`, so these need `npm run
 * build:server` after a server change — the packer's rules are covered
 * against the sources in `server/tests/packages/package-builder.test.ts`.
 *
 * The child process runs one kernel for the server and the workspace, so the
 * part snapshots carry their parameters here (see that file's note).
 */

const REPO = path.resolve(import.meta.dirname, '../../..');
const CLI = path.join(REPO, 'bin', 'fluidcad.js');
const COMPILED = path.join(REPO, 'server', 'dist', 'packages', 'package-builder.js');
const FIXTURE = path.join(REPO, 'server', 'tests', 'fixtures', 'package-workspace');

let scratch: string;
let workspace: string;
let library: string;

function cli(args: string[], cwd = workspace): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    // Nothing here touches the user library; point it at a temp directory anyway.
    env: { ...process.env, FLUIDCAD_PACKAGES: library },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The workspace's entries, workspace-relative, with a file's size and mtime. */
function listing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(workspace, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else {
        const stat = fs.lstatSync(abs);
        out.push(`${rel} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  walk(workspace);
  return out.sort();
}

function write(rel: string, contents: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

async function manifestOf(archive: string): Promise<Record<string, any>> {
  const zip = await JSZip.loadAsync(fs.readFileSync(archive));
  return JSON.parse(await zip.file('manifest.json')!.async('string'));
}

beforeAll(() => {
  expect(fs.existsSync(COMPILED), 'server/dist is not built: run `npm run build:server`').toBe(true);
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-cli-pack-'));
  workspace = path.join(scratch, 'kit');
  library = path.join(scratch, 'library');
  fs.mkdirSync(library);
  fs.cpSync(FIXTURE, workspace, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('fluidcad pack', () => {
  it('writes <scope>-<name>-<version>.fluidpkg in the workspace, and nothing else, and prints the summary', async () => {
    const before = listing();
    const run = cli(['pack']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const archive = path.join(workspace, 'acme-kit-0.1.0.fluidpkg');
    expect(run.stdout.split('\n')).toEqual([
      expect.stringMatching(/^Packed @acme\/kit 0\.1\.0 → .*\/acme-kit-0\.1\.0\.fluidpkg$/),
      '  features/   2 features: fastener, standoff',
      '  parts/      1 part: spacer',
      '  assemblies/ 0 assemblies',
      expect.stringMatching(/^ {2}21 files, \d+\.\d kB, unit mm$/),
      '',
      // The fixture documents none of its fields: a warning per module, and it still packs.
      '3 warnings (the package still packed):',
      '  ! features/fastener.feature.js: 7 fields without a description — fastener: at, standard, size, head, depth, marking, finishes. Give each a `description`.',
      '  ! features/standoff.feature.js: 4 fields without a description — standoff: face, height, outer, hole. Give each a `description`.',
      '  ! parts/spacer.part.js: 1 field without a description — spacer: Length. Give it a `description`.',
      '',
    ]);
    // The archive is the only new entry; no engine link, no cache.
    const after = listing();
    expect(after.filter((entry) => !before.includes(entry))).toEqual([
      expect.stringMatching(/^acme-kit-0\.1\.0\.fluidpkg \d+ /),
    ]);
    expect(before.filter((entry) => !after.includes(entry))).toEqual([]);
    expect(fs.readdirSync(library)).toEqual([]);

    const manifest = await manifestOf(archive);
    expect(manifest.name).toBe('@acme/kit');
    expect(manifest.files).not.toContain('demo.part.js');
    expect(manifest.parts).toEqual([{
      exportName: 'spacer',
      module: 'parts/spacer.part.js',
      name: 'Spacer',
      kind: 'part',
      exportKind: 'value',
      params: [{ label: 'Length', defaultValue: 0.5, currentValue: 0.5, controlType: 'number', min: 0.1 }],
    }]);
  });

  it('writes to the file -o names, or into the directory it names', () => {
    const file = path.join(scratch, 'out', 'kit.fluidpkg');
    fs.mkdirSync(path.dirname(file));
    expect(cli(['pack', '-o', file]).status).toBe(0);
    expect(fs.existsSync(file)).toBe(true);

    const dir = path.join(scratch, 'dist');
    fs.mkdirSync(dir);
    expect(cli(['pack', '--out', dir]).status).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(['acme-kit-0.1.0.fluidpkg']);
    expect(fs.existsSync(path.join(workspace, 'acme-kit-0.1.0.fluidpkg'))).toBe(false);
  });

  it('takes the workspace from --workspace', () => {
    const elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const run = cli(['pack', '-w', workspace], elsewhere);
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(workspace, 'acme-kit-0.1.0.fluidpkg'))).toBe(true);
  });

  it('packs again after `fluidcad version patch`, under the new version\'s name', async () => {
    expect(cli(['pack']).status).toBe(0);
    expect(cli(['version', 'patch']).status).toBe(0);
    const run = cli(['pack']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Packed @acme/kit 0.1.1');
    expect((await manifestOf(path.join(workspace, 'acme-kit-0.1.1.fluidpkg'))).version).toBe('0.1.1');
    expect(fs.existsSync(path.join(workspace, 'acme-kit-0.1.0.fluidpkg'))).toBe(true);
  });

  it('refuses a workspace that isn\'t a package, writing nothing', () => {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8'));
    delete config.package;
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify(config));
    const before = listing();

    const run = cli(['pack']);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe("This workspace isn't a package — run `fluidcad package init` first.\n");
    expect(listing()).toEqual(before);
  });

  it('prints a failed check\'s sentence and exits 1', () => {
    fs.rmSync(path.join(workspace, 'features', 'standoff.svg'));
    const run = cli(['pack']);
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(
      "features/standoff.feature.js declares the image ./standoff.svg (feature 'standoff'), which doesn't exist next to the module.\n",
    );
  });

  it('refuses a minEngine older than the first FluidCAD of its feature SDK, naming both, and writes nothing', () => {
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8'));
    config.package.minEngine = '0.0.40';
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify(config));
    const before = listing();
    const run = cli(['pack']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"minEngine" 0.0.40');
    expect(run.stderr).toContain('feature SDK 1, which FluidCAD 0.0.45 introduced');
    expect(listing()).toEqual(before);
  });

  it('--json prints the archive and its contents by folder', () => {
    const run = cli(['pack', '--json', '-o', scratch]);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toEqual({
      name: '@acme/kit',
      version: '0.1.0',
      fileName: 'acme-kit-0.1.0.fluidpkg',
      savedTo: path.join(scratch, 'acme-kit-0.1.0.fluidpkg'),
      bytes: fs.statSync(path.join(scratch, 'acme-kit-0.1.0.fluidpkg')).size,
      files: 21,
      unit: 'mm',
      contents: {
        features: [
          { id: 'fastener', exportName: 'fastener', module: 'features/fastener.feature.js' },
          { id: 'standoff', exportName: 'standoff', module: 'features/standoff.feature.js' },
        ],
        parts: [{ exportName: 'spacer', name: 'Spacer', module: 'parts/spacer.part.js', params: 1 }],
        assemblies: [],
        models: 1,
        docs: [],
      },
      warnings: [
        expect.objectContaining({ code: 'undocumented-fields', file: 'features/fastener.feature.js' }),
        expect.objectContaining({ code: 'undocumented-fields', file: 'features/standoff.feature.js' }),
        {
          code: 'undocumented-fields',
          file: 'parts/spacer.part.js',
          message: 'parts/spacer.part.js: 1 field without a description — spacer: Length. Give it a `description`.',
          fields: [{ kind: 'param', owner: 'spacer', name: 'Length', label: 'Length', reason: 'missing' }],
        },
      ],
    });
  });

  it('lists the doc pages in the summary, ships docs/, and prints a broken link as a warning: still exit 0', async () => {
    write('docs/standoff.md', '# Standoff\n\n![A standoff](./images/standoff.svg)\n\nSee the [README](../README.md) and [the guide](./guide.md).\n');
    write('docs/images/standoff.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    write('docs/fastener.md', '# Fastener\n');

    const run = cli(['pack']);

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines).toContain('  docs/       2 pages: fastener.md, standoff.md');
    expect(lines).toContain('4 warnings (the package still packed):');
    expect(lines).toContain('  ! docs/standoff.md:5 links to ./guide.md, which leads to no file the package ships.');
    const manifest = await manifestOf(path.join(workspace, 'acme-kit-0.1.0.fluidpkg'));
    expect(manifest.files.filter((f: string) => f.startsWith('docs/'))).toEqual(['docs/fastener.md', 'docs/images/standoff.svg', 'docs/standoff.md']);

    const json = JSON.parse(cli(['pack', '--json', '-o', scratch]).stdout);
    expect(json.contents.docs).toEqual(['docs/fastener.md', 'docs/standoff.md']);
    expect(json.warnings.filter((w: any) => w.code === 'docs-link')).toEqual([{
      code: 'docs-link',
      file: 'docs/standoff.md',
      message: 'docs/standoff.md:5 links to ./guide.md, which leads to no file the package ships.',
      target: './guide.md',
      line: 5,
    }]);
  });

  it('prints no warnings for a package whose fields are all documented and whose links resolve', () => {
    // A features-only package of the documented standoff: no part, so no parameter to describe.
    fs.rmSync(path.join(workspace, 'parts'), { recursive: true });
    fs.rmSync(path.join(workspace, 'demo.part.js'));
    fs.rmSync(path.join(workspace, 'features', 'fastener.feature.js'));
    const standoff = path.join(workspace, 'features', 'standoff.feature.js');
    fs.writeFileSync(standoff, fs.readFileSync(standoff, 'utf8')
      .replace("surface: 'planar' },", "surface: 'planar', description: 'The planar face the standoff stands on, at its centre.' },")
      .replace("height: { type: 'length', default: 10, min: 0 },", "height: { type: 'length', default: 10, min: 0, description: 'How tall the standoff stands above the face.' },")
      .replace("label: 'Boss diameter' },", "label: 'Boss diameter', description: 'The outside diameter of the boss.' },")
      .replace("label: 'Hole diameter' },", "label: 'Hole diameter', description: 'The bore through the boss, narrower than it.' },"));
    write('docs/standoff.md', '# Standoff\n\nSee the [README](../README.md).\n');

    const run = cli(['pack']);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain('warning');
    expect(JSON.parse(cli(['pack', '--json', '-o', scratch]).stdout).warnings).toEqual([]);
  });

  it('refuses a file docs/ can\'t hold, with its code, and writes nothing', () => {
    write('docs/model.step', 'ISO-10303-21;');
    const before = listing();
    const run = cli(['pack', '--json']);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      error: "docs/model.step can't ship: docs/ holds markdown pages (.md) and the images they show (.svg, .png, .jpg, .jpeg, .webp) only. Move it out of docs/ or remove it.",
      code: 'docs-file',
    });
    expect(listing()).toEqual(before);
  });

  it('--json prints a refusal as { error, code } and exits 1', () => {
    fs.renameSync(path.join(workspace, 'parts', 'spacer.part.js'), path.join(workspace, 'features', 'spacer.part.js'));
    const run = cli(['pack', '--json']);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      error: 'features/spacer.part.js is a part in features/, but parts belong in parts/: move it there.',
      code: 'wrong-folder',
    });
  });

  it('says when a package has no parts or assemblies: a local pack, not a publishable one', () => {
    fs.rmSync(path.join(workspace, 'parts'), { recursive: true });
    fs.rmSync(path.join(workspace, 'demo.part.js'));
    const run = cli(['pack']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('  parts/      0 parts\n');
    expect(run.stdout).toContain('  no parts or assemblies: the hub needs at least one to publish\n');
  });

  it('no longer takes --entry or --name', () => {
    for (const flag of ['--entry', '--name']) {
      const run = cli(['pack', flag, 'x']);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(`unknown option '${flag}'`);
    }
  });
});
