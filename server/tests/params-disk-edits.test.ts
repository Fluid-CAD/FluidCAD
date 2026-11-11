import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ParamsDiskEdits } from '../src/files/params-disk-edits.ts';
import { GlobalParamCatalog } from '../src/global-params/catalog.ts';
import { normalizePath } from '../src/normalize-path.ts';

// A params file saved from outside the page, under a live buffer the server
// kept from an earlier column edit, is adopted — the catalog (and the render)
// read the buffer over the disk, so the save was masked (GH #95).

const BEFORE = [
  `import { param } from 'fluidcad/core';`,
  `export const length = param('Length', 128, 'number');`,
  ``,
].join('\n');

const AFTER = [
  `import { param } from 'fluidcad/core';`,
  `export const length = param('Length', 128, 'number', { group: 'Needle', description: 'TEST' });`,
  ``,
].join('\n');

describe('ParamsDiskEdits', () => {
  let ws: string;
  let file: string;
  let buffers: Map<string, string>;
  let pageWrote: string | null;
  let renders: string[];
  let edits: ParamsDiskEdits;
  let catalog: GlobalParamCatalog;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-params-disk-')));
    file = normalizePath(join(ws, 'project.params.js'));
    buffers = new Map();
    pageWrote = null;
    renders = [];
    catalog = new GlobalParamCatalog({ workspacePath: ws, readBuffer: (absPath) => buffers.get(absPath) ?? null });
    edits = new ParamsDiskEdits({
      getBuffer: (absPath) => buffers.get(absPath) ?? null,
      readFile: (absPath) => readFile(absPath, 'utf8').catch((): null => null),
      isPageWrite: (_absPath, code) => code === pageWrote,
      // What `runLiveRender` does for a params file: the buffer, then the catalog.
      render: async (absPath, code) => {
        renders.push(code);
        buffers.set(absPath, code);
        catalog.noteFileChange(absPath);
      },
    });
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const length = async () => (await catalog.snapshot()).files[0].params[0];

  it('adopts a save from outside over the buffer a column edit left, so the catalog reads its group and description', async () => {
    writeFileSync(file, BEFORE);
    buffers.set(file, BEFORE);
    expect((await length()).group).toBeUndefined();

    writeFileSync(file, AFTER);
    // The masked state: the catalog rescans, and still reads the buffer.
    catalog.noteFileChange(file);
    expect((await length()).group).toBeUndefined();

    expect(await edits.note('file-changed', file)).toBe(true);
    expect(renders).toEqual([AFTER]);
    expect(await length()).toMatchObject({ group: 'Needle', description: 'TEST' });
  });

  it('leaves a file with no buffer to its readers, which read the disk', async () => {
    writeFileSync(file, AFTER);
    expect(await edits.note('file-added', file)).toBe(false);
    expect(renders).toEqual([]);
    expect(await length()).toMatchObject({ group: 'Needle', description: 'TEST' });
  });

  it('renders nothing when the disk holds what the buffer does', async () => {
    writeFileSync(file, AFTER);
    buffers.set(file, AFTER);
    expect(await edits.note('file-changed', file)).toBe(false);
    expect(renders).toEqual([]);
  });

  it("leaves the page's own save to the page, which renders what it writes", async () => {
    writeFileSync(file, AFTER);
    buffers.set(file, BEFORE);
    pageWrote = AFTER;
    expect(await edits.note('file-changed', file)).toBe(false);
    expect(renders).toEqual([]);
  });

  it('ignores a removed file, an unreadable one, and any file that is not a params file', async () => {
    buffers.set(file, BEFORE);
    expect(await edits.note('file-removed', file)).toBe(false);
    expect(await edits.note('file-changed', file)).toBe(false);
    const model = normalizePath(join(ws, 'bracket.part.js'));
    writeFileSync(model, AFTER);
    buffers.set(model, BEFORE);
    expect(await edits.note('file-changed', model)).toBe(false);
    expect(renders).toEqual([]);
  });
});
