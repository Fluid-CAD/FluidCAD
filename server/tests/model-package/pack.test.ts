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
    write('widget.fluid.js', "import { rect } from 'fluidcad/core';\nrect(1, 1);\n");
    write('init.js', "import { init } from 'fluidcad';\nexport default await init();\n");
    write('package.json', JSON.stringify({ name: 'widget', version: '1.2.3' }));
    write('README.md', '# Widget');
    write('fluidcad.json', JSON.stringify({ modelId: 'abc' }));
    write('notes.md', 'design notes'); // not imported anywhere — only Pack v2 captures it
    write('parts/helper.js', 'export const x = 1;');
    // Ignored / always-excluded — must never ship:
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
    expect(files).toContain('fluidcad.json');
    expect(files).toContain('notes.md');
    expect(files).toContain('parts/helper.js');

    // Excluded — secrets, gitignored paths, build artifacts, deps, and every
    // hidden dot-entry (incl. .gitignore itself and dot-FOLDERS like .claude):
    expect(files).not.toContain('secret.txt');
    expect(files).not.toContain('build/out.txt');
    expect(files).not.toContain('.env');
    expect(files).not.toContain('.gitignore');
    expect(files).not.toContain('old.fluidpkg');
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
  });

  it('with no .gitignore, includes everything but hidden dot-entries', async () => {
    write('model.fluid.js', "import { rect } from 'fluidcad/core';\nrect(1, 1);\n");
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
    write('m.fluid.js', "import { rect } from 'fluidcad/core';\nrect(1, 1);\n");
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
