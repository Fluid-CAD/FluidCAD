// Who reads a part's connector by name from another file — the question that
// decides whether a removed hole may take its connector along. The answer
// errs towards a read: only a holder traced to another definition is not one.

import { describe, it, expect } from 'vitest';
import { getJavaScriptParser } from '../src/code-editor/index.ts';
import { ConnectorReads, WorkspaceConnectorReads, type ConnectorOwner, type HoleConnector } from '../src/hole-connectors.ts';
import type { WorkspaceScripts } from '../src/workspace-scripts.ts';

const PLATE_FILE = '/ws/parts/plate.part.js';
const H1: ConnectorOwner = { name: 'h1', definition: { localName: 'plate', exportName: 'plate' } };

/** The lines of `code`, read as `filePath`, that read `owner`'s connector by name. */
async function readLines(code: string, owner: ConnectorOwner = H1, filePath = '/ws/frame.assembly.js'): Promise<number[]> {
  const parser = await getJavaScriptParser();
  return ConnectorReads.inOtherFile(parser.parse(code), filePath, PLATE_FILE, owner)
    .sites()
    .map((site) => site.startPosition.row + 1);
}

describe('ConnectorReads — another file', () => {
  it('finds the reads off an instance of the imported part, however the key is spelled', async () => {
    const code = [
      `import { insert, mate } from 'fluidcad/core';`,
      `import { plate } from './parts/plate.part.js';`,
      `const p1 = insert(plate).grounded();`,
      `const p2 = insert(plate, { Width: 40 });`,
      `mate('fastened', p1.connectors.h1, p2.connectors['h1']);`,
      `mate('revolute', p1.connectors.h1.instance(2), p2.connectors.tip);`,
    ].join('\n');
    expect(await readLines(code)).toEqual([5, 5, 6]);
  });

  it('reaches the declaring file through a renamed import and an omitted suffix', async () => {
    const code = [
      `import { plate as base } from './parts/plate.part';`,
      `const p1 = insert(base);`,
      `mate('fastened', p1.connectors.h1, other);`,
    ].join('\n');
    expect(await readLines(code)).toEqual([3]);
  });

  it('is not a read off another part: another file, another export, a local part', async () => {
    const code = [
      `import { cover } from './parts/cover.part.js';`,
      `import { lid } from './parts/plate.part.js';`,
      `import { bolt } from 'some-package';`,
      `const local = part('Local', () => { connector('h1', origin()); });`,
      `const a = insert(cover);`,
      `const b = insert(lid);`,
      `const c = insert(bolt);`,
      `const d = insert(local);`,
      `mate('fastened', a.connectors.h1, b.connectors.h1);`,
      `mate('fastened', c.connectors.h1, d.connectors.h1);`,
    ].join('\n');
    expect(await readLines(code)).toEqual([]);
  });

  it('is not a read of another connector of the same part', async () => {
    const code = [
      `import { plate } from './parts/plate.part.js';`,
      `const p1 = insert(plate);`,
      `mate('fastened', p1.connectors.h2, p1.connectors['tip']);`,
    ].join('\n');
    expect(await readLines(code)).toEqual([]);
  });

  it('traces an inline insert() through its definition, whatever insert itself is', async () => {
    const code = [
      `import { insert, mate } from 'fluidcad/core';`,
      `import { plate } from './parts/plate.part.js';`,
      `import { cover } from './parts/cover.part.js';`,
      `mate('fastened', insert(plate).grounded().connectors.h1, insert(cover).connectors.h1);`,
    ].join('\n');
    expect(await readLines(code)).toEqual([4]);
  });

  it('counts the result of a function it cannot see into, imported or not', async () => {
    const code = [
      `import { mounted } from './helpers.js';`,
      `const a = mounted(1).connectors.h1;`,
      `const b = local().instance(2).connectors.h1;`,
    ].join('\n');
    expect(await readLines(code)).toEqual([2, 3]);
  });

  it('counts every holder it cannot trace', async () => {
    const code = [
      `import { stack } from './stack.assembly.js';`,
      `import plateDefault from './parts/plate.part.js';`,
      `import * as parts from './parts/plate.part.js';`,
      `const occ = insert(stack);`,
      `const viaHop = occ.parts.plate.connectors.h1;`,
      `const [replica] = replicate(seed, [target], [[other]]);`,
      `const viaReplica = replica.connectors.h1;`,
      `const viaDefault = insert(plateDefault).connectors.h1;`,
      `const viaNamespace = insert(parts.plate);`,
      `const read = viaNamespace.connectors.h1;`,
      `function frame(instance) { return instance.connectors.h1; }`,
    ].join('\n');
    expect(await readLines(code)).toEqual([5, 7, 8, 10, 11]);
  });

  it('counts a `.connectors` object that escapes: a computed key, a destructuring, a hand-off', async () => {
    const code = [
      `import { plate } from './parts/plate.part.js';`,
      `const p1 = insert(plate);`,
      `const byKey = p1.connectors[name];`,
      `const { h1 } = p1.connectors;`,
      `list(p1.connectors);`,
    ].join('\n');
    expect(await readLines(code)).toEqual([3, 4, 5]);
  });

  it('treats an import of the declaring file as the owner when the part has no export name to tell by', async () => {
    const code = [
      `import { anything } from './parts/plate.part.js';`,
      `const p1 = insert(anything);`,
      `mate('fastened', p1.connectors.h1, other);`,
    ].join('\n');
    expect(await readLines(code, { name: 'h1', definition: { localName: null, exportName: null } })).toEqual([3]);
    expect(await readLines(code, { name: 'h1', definition: null })).toEqual([3]);
  });
});

describe('WorkspaceConnectorReads.unread', () => {
  const connector = (name: string): HoleConnector => ({
    statement: null as never,
    variable: name,
    owner: { name, definition: { localName: 'plate', exportName: 'plate' } },
  });

  function reads(files: Record<string, string>): WorkspaceConnectorReads {
    const scripts = {
      others: async (filePath: string) => Object.entries(files)
        .filter(([path]) => path !== filePath)
        .map(([path, code]) => ({ filePath: path, code })),
    } as unknown as WorkspaceScripts;
    return new WorkspaceConnectorReads(scripts);
  }

  it('drops the connectors any other script reads and keeps the rest', async () => {
    const workspace = reads({
      [PLATE_FILE]: `const p = insert(plate); p.connectors.h2;`,
      '/ws/frame.assembly.js': `import { plate } from './parts/plate.part.js';\nconst p1 = insert(plate);\nmate('fastened', p1.connectors.h1, x);`,
      '/ws/other.assembly.js': `import { cover } from './parts/cover.part.js';\nconst c = insert(cover);\nmate('fastened', c.connectors.h2, x);`,
      '/ws/notes.fluid.js': `const text = 'h2 h3';`,
    });
    const unread = await workspace.unread(PLATE_FILE, [connector('h1'), connector('h2'), connector('h3')]);
    expect(unread.map((c) => c.variable)).toEqual(['h2', 'h3']);
  });

  it('has nothing to ask the workspace for no connectors', async () => {
    const scripts = { others: async () => { throw new Error('the workspace was read'); } } as unknown as WorkspaceScripts;
    expect(await new WorkspaceConnectorReads(scripts).unread(PLATE_FILE, [])).toEqual([]);
  });
});
