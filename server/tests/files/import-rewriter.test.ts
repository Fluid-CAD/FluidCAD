import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  rewriteModuleSpecifiers,
  planImportUpdates,
  applyImportUpdates,
} from '../../src/files/import-rewriter.ts';

// The rewriter is what keeps a workspace consistent across a rename, so the
// tests read as the guarantees it makes: only module specifiers change, a
// file it can't trust is skipped and named, and nothing is written that
// wasn't planned against the disk as it was read.

const WS = '/ws';

function req(content: string, overrides: Partial<Parameters<typeof rewriteModuleSpecifiers>[0]> = {}) {
  return rewriteModuleSpecifiers({
    content,
    fromDir: WS,
    toDir: WS,
    oldAbsPath: `${WS}/bracket.part.js`,
    newAbsPath: `${WS}/arm.part.js`,
    ...overrides,
  });
}

describe('rewriteModuleSpecifiers', () => {
  it('re-points every specifier form at the new name and nothing else', async () => {
    const source = [
      "import { sketch } from 'fluidcad';",
      "import { bracket } from './bracket.part.js';",
      'export { bracket as b } from "./bracket.part.js";',
      "export * from './bracket.part.js';",
      "const lazy = () => import('./bracket.part.js');",
      "import { helper } from './helpers.js';",
      "const text = 'not ./bracket.part.js at all';",
      '',
    ].join('\n');
    const outcome = await req(source);
    expect(outcome.kind).toBe('rewritten');
    if (outcome.kind !== 'rewritten') {
      return;
    }
    expect(outcome.content).toBe(source.replaceAll('./bracket.part.js', './arm.part.js').replace("'not ./arm.part.js at all'", "'not ./bracket.part.js at all'"));
    expect(outcome.replacements).toEqual([
      { from: './bracket.part.js', to: './arm.part.js' },
      { from: './bracket.part.js', to: './arm.part.js' },
      { from: './bracket.part.js', to: './arm.part.js' },
      { from: './bracket.part.js', to: './arm.part.js' },
    ]);
  });

  it('keeps an extensionless specifier extensionless, and a bare one alone', async () => {
    const outcome = await req("import { h } from './helpers';\nimport x from 'helpers';\n", {
      oldAbsPath: `${WS}/helpers.js`,
      newAbsPath: `${WS}/util.js`,
    });
    expect(outcome).toMatchObject({ kind: 'rewritten', content: "import { h } from './util';\nimport x from 'helpers';\n" });
  });

  it('reaches into a folder the file moved to, and back out of it', async () => {
    const down = await req("import { bracket } from './bracket.part.js';\n", { newAbsPath: `${WS}/parts/bracket.part.js` });
    expect(down).toMatchObject({ kind: 'rewritten', content: "import { bracket } from './parts/bracket.part.js';\n" });

    const up = await req("import { bracket } from '../bracket.part.js';\n", {
      fromDir: `${WS}/asm`,
      toDir: `${WS}/asm`,
      newAbsPath: `${WS}/parts/bracket.part.js`,
    });
    expect(up).toMatchObject({ kind: 'rewritten', content: "import { bracket } from '../parts/bracket.part.js';\n" });
  });

  it("re-bases a moved file's own imports of other files", async () => {
    const outcome = await req("import { sketch } from 'fluidcad';\nimport { h } from './helpers.js';\nimport { p } from '../shared/p.js';\n", {
      fromDir: WS,
      toDir: `${WS}/parts`,
      newAbsPath: `${WS}/parts/bracket.part.js`,
    });
    expect(outcome).toMatchObject({
      kind: 'rewritten',
      content: "import { sketch } from 'fluidcad';\nimport { h } from '../helpers.js';\nimport { p } from '../../shared/p.js';\n",
    });
  });

  it('reports a file that has nothing to change as unchanged', async () => {
    expect(await req("import { h } from './helpers.js';\n")).toEqual({ kind: 'unchanged' });
    expect(await req('')).toEqual({ kind: 'unchanged' });
  });

  it('skips a file with syntax errors instead of guessing at it', async () => {
    const outcome = await req("import { bracket } from './bracket.part.js';\nconst x = (;\n");
    expect(outcome).toEqual({ kind: 'skipped', reason: 'it has syntax errors' });
  });

  it('leaves a specifier with an escape sequence alone', async () => {
    const outcome = await req("import { bracket } from './bracket\\u002epart.js';\n");
    expect(outcome).toEqual({ kind: 'unchanged' });
  });
});

describe('planImportUpdates / applyImportUpdates', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-rewrite-')));
  });

  afterAll(() => {
    // Each test's workspace is small; leaving the last one is harmless, but tidy up.
  });

  function write(rel: string, content: string): string {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  function plan(buffers: Record<string, string> = {}, newRel = 'arm.part.js') {
    return planImportUpdates({
      workspacePath: workspace,
      oldAbsPath: `${workspace}/bracket.part.js`,
      oldRelPath: 'bracket.part.js',
      newAbsPath: `${workspace}/${newRel}`,
      newRelPath: newRel,
      buffers,
    });
  }

  it('writes clean importers atomically and hands unsaved buffers back unwritten', async () => {
    write('bracket.part.js', 'export const bracket = 1;\n');
    write('rig.assembly.js', "import { bracket } from './bracket.part.js';\n");
    write('sub/other.js', "import { bracket } from '../bracket.part.js';\n");
    write('notes.json', '{"import":"./bracket.part.js"}');
    const bufferText = "// unsaved\nimport { bracket } from '../bracket.part.js';\n";

    const planned = await plan({ 'sub/other.js': bufferText });
    expect(planned.skipped).toEqual([]);
    expect(planned.files.map((f) => [f.path, f.fromBuffer])).toEqual([
      ['rig.assembly.js', false],
      ['sub/other.js', true],
    ]);
    // Planning wrote nothing.
    expect(fs.readFileSync(path.join(workspace, 'rig.assembly.js'), 'utf8')).toContain('./bracket.part.js');

    fs.renameSync(path.join(workspace, 'bracket.part.js'), path.join(workspace, 'arm.part.js'));
    const ledger: string[] = [];
    const result = applyImportUpdates(planned, (absPath) => ledger.push(path.basename(absPath)));

    expect(result.skipped).toEqual([]);
    expect(result.updated.map((u) => [u.path, u.mtimeMs === null])).toEqual([
      ['rig.assembly.js', false],
      ['sub/other.js', true],
    ]);
    expect(fs.readFileSync(path.join(workspace, 'rig.assembly.js'), 'utf8')).toBe("import { bracket } from './arm.part.js';\n");
    // The buffer's file on disk is untouched; the caller got the rewritten text.
    expect(fs.readFileSync(path.join(workspace, 'sub/other.js'), 'utf8')).toBe("import { bracket } from '../bracket.part.js';\n");
    expect(result.updated[1].content).toBe("// unsaved\nimport { bracket } from '../arm.part.js';\n");
    expect(ledger).toEqual(['rig.assembly.js']);
    // No temp files left behind.
    expect(fs.readdirSync(workspace).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rewrites the moved file itself at its new location', async () => {
    write('bracket.part.js', "import { h } from './helpers.js';\nexport const bracket = h;\n");
    write('helpers.js', 'export const h = 1;\n');
    const planned = await plan({}, 'parts/bracket.part.js');
    expect(planned.files.map((f) => f.path)).toEqual(['parts/bracket.part.js']);

    fs.mkdirSync(path.join(workspace, 'parts'));
    fs.renameSync(path.join(workspace, 'bracket.part.js'), path.join(workspace, 'parts/bracket.part.js'));
    const result = applyImportUpdates(planned);
    expect(result.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(workspace, 'parts/bracket.part.js'), 'utf8')).toBe(
      "import { h } from '../helpers.js';\nexport const bracket = h;\n",
    );
  });

  it('refuses to overwrite an importer that changed between planning and writing', async () => {
    write('bracket.part.js', '');
    const importer = write('rig.assembly.js', "import { bracket } from './bracket.part.js';\n");
    const planned = await plan();
    expect(planned.files).toHaveLength(1);

    // Someone else saves meanwhile.
    const edited = "import { bracket } from './bracket.part.js'; // edited\n";
    fs.writeFileSync(importer, edited);
    fs.renameSync(path.join(workspace, 'bracket.part.js'), path.join(workspace, 'arm.part.js'));

    const result = applyImportUpdates(planned);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([{ path: 'rig.assembly.js', reason: 'it changed on disk while the rename was running' }]);
    expect(fs.readFileSync(importer, 'utf8')).toBe(edited);
  });

  it('names an importer it could not rewrite', async () => {
    write('bracket.part.js', '');
    write('broken.js', "import { bracket } from './bracket.part.js';\nlet = ;\n");
    write('fine.js', "import { bracket } from './bracket.part.js';\n");
    const planned = await plan();
    expect(planned.skipped).toEqual([{ path: 'broken.js', reason: 'it has syntax errors' }]);
    expect(planned.files.map((f) => f.path)).toEqual(['fine.js']);
  });
});
