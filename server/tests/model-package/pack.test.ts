import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';
import { packModel } from '../../src/model-package/pack.ts';
import type { ParamDefinition } from '../../../lib/dist/index.js';

let ws: string;

function write(rel: string, contents: string) {
  const abs = join(ws, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

async function zipEntries(buf: Buffer): Promise<string[]> {
  const z = await JSZip.loadAsync(buf);
  return Object.keys(z.files).filter((n) => !z.files[n].dir);
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'fluidpack-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('packModel — Pack v2 workspace packaging', () => {
  it('ships the whole non-ignored tree under files/, honoring .gitignore', async () => {
    write('widget.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");
    write('init.js', "import { init } from 'fluidcad';\nexport default await init();\n");
    write('package.json', JSON.stringify({ name: 'widget', version: '1.2.3' }));
    write('README.md', '# Widget');
    write('notes.md', 'design notes'); // not imported anywhere — only Pack v2 captures it
    write('parts/helper.js', 'export const x = 1;');
    // Ignored / always-excluded — must never ship:
    write('fluidcad.json', JSON.stringify({ modelId: 'abc' })); // local hub binding, not model source
    write('.gitignore', 'secret.txt\nbuild/\n');
    write('secret.txt', 'TOPSECRET');
    write('build/out.txt', 'artifact');
    write('.env', 'API_KEY=shh');
    write('old.fluidpkg', 'stale package bytes');
    write('node_modules/dep/index.js', 'module.exports = 1;');
    // Hidden dot-entries are excluded even WITH a .gitignore that doesn't list
    // them — editor/tool state (the .claude case that leaked in the field).
    write('.claude/settings.local.json', '{"secret":true}');
    write('.vscode/settings.json', '{}');

    const { manifest, zip } = await packModel({
      entryPath: join(ws, 'widget.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.34',
    });

    const files = manifest.files ?? [];
    // Included — the full human tree:
    expect(files).toContain('widget.fluid.js');
    expect(files).toContain('init.js');
    expect(files).toContain('package.json');
    expect(files).toContain('README.md');
    expect(files).toContain('notes.md');
    expect(files).toContain('parts/helper.js');

    // Excluded — secrets, gitignored paths, build artifacts, deps, and every
    // hidden dot-entry (incl. .gitignore itself and dot-FOLDERS like .claude):
    expect(files).not.toContain('secret.txt');
    expect(files).not.toContain('build/out.txt');
    expect(files).not.toContain('.env');
    expect(files).not.toContain('.gitignore');
    expect(files).not.toContain('old.fluidpkg');
    expect(files).not.toContain('fluidcad.json');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.split('/').some((seg) => seg.startsWith('.')))).toBe(false);

    // The zip mirrors manifest.files under files/, and never leaks excluded bytes.
    const entries = await zipEntries(zip);
    expect(entries).toContain('files/README.md');
    expect(entries).toContain('files/parts/helper.js');
    expect(entries.some((e) => e.includes('secret.txt'))).toBe(false);
    expect(entries.some((e) => e.includes('.env'))).toBe(false);
    expect(entries.some((e) => e.includes('.claude') || e.includes('.vscode'))).toBe(false);
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false);
    expect(entries.some((e) => e.includes('fluidcad.json'))).toBe(false);
  });

  it('with no .gitignore, includes everything but hidden dot-entries', async () => {
    write('model.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");
    write('package.json', JSON.stringify({ name: 'm' }));
    write('.hidden', 'should be skipped');
    write('.config/settings.json', '{}'); // hidden dir → skipped
    write('keep.txt', 'kept');

    const { manifest } = await packModel({
      entryPath: join(ws, 'model.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.34',
    });
    const files = manifest.files ?? [];
    expect(files).toContain('model.fluid.js');
    expect(files).toContain('keep.txt');
    expect(files).not.toContain('.hidden');
    expect(files.some((f) => f.startsWith('.config/'))).toBe(false);
  });

  it('embeds paramDefinitions only when provided', async () => {
    write('m.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");
    const defs: ParamDefinition[] = [
      { label: 'width', defaultValue: 10, currentValue: 10, controlType: 'number' },
    ];

    const withDefs = await packModel({
      entryPath: join(ws, 'm.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.34',
      paramDefinitions: defs,
    });
    expect(withDefs.manifest.paramDefinitions).toEqual(defs);

    const withoutDefs = await packModel({
      entryPath: join(ws, 'm.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.34',
    });
    expect(withoutDefs.manifest.paramDefinitions).toBeUndefined();
  });
});

describe('packModel — units (manifest v3)', () => {
  it('records the project unit from fluidcad.json and each script\'s unit() declaration', async () => {
    write('fluidcad.json', JSON.stringify({ unit: 'in' }));
    write('bracket.fluid.js', "import { circle } from 'fluidcad/core';\nunit('mm');\ncircle(1);\n");
    write('parts/pin.part.js', "import { part } from 'fluidcad';\nunit('cm');\nexport const pin = part('pin', () => {});\n");
    write('parts/plain.part.js', "import { part } from 'fluidcad';\nexport const plain = part('plain', () => {});\n");
    write('README.md', "unit('ft') mentioned in prose must not count");

    const { manifest, zip } = await packModel({
      entryPath: join(ws, 'bracket.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.42',
    });

    expect(manifest.schemaVersion).toBe(3);
    // Lifted out of fluidcad.json — which itself still never ships.
    expect(manifest.unit).toBe('in');
    expect(manifest.files).not.toContain('fluidcad.json');
    // Only declaring scripts appear; `files` stays a plain path list.
    expect(manifest.fileUnits).toEqual({ 'bracket.fluid.js': 'mm', 'parts/pin.part.js': 'cm' });
    expect(manifest.files).toContain('parts/plain.part.js');

    const z = await JSZip.loadAsync(zip);
    const stored = JSON.parse(await z.file('manifest.json')!.async('string'));
    expect(stored.unit).toBe('in');
    expect(stored.fileUnits['parts/pin.part.js']).toBe('cm');
  });

  it('defaults the project unit to mm and omits fileUnits when no script declares one', async () => {
    write('m.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");

    const { manifest } = await packModel({
      entryPath: join(ws, 'm.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.42',
    });
    expect(manifest.unit).toBe('mm');
    expect('fileUnits' in manifest).toBe(false);
  });

  it('prefers an explicit unit input over fluidcad.json', async () => {
    write('fluidcad.json', JSON.stringify({ unit: 'in' }));
    write('m.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");

    const { manifest } = await packModel({
      entryPath: join(ws, 'm.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.42',
      unit: 'cm',
    });
    expect(manifest.unit).toBe('cm');
  });

  it('ignores a unit() literal that is not a length unit', async () => {
    write('m.fluid.js', "import { circle } from 'fluidcad/core';\nunit('furlong');\ncircle(1);\n");

    const { manifest } = await packModel({
      entryPath: join(ws, 'm.fluid.js'),
      workspacePath: ws,
      fluidcadVersion: '0.0.42',
    });
    expect('fileUnits' in manifest).toBe(false);
  });
});
