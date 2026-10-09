import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import type { SceneRenderedData } from '../src/fluidcad-server/render-types.ts';

// A workspace opened through a symlinked directory (`~/cad` → a volume, or
// a linked parent): the host is handed the link's spelling of the entry,
// while Vite names the modules it loads by their real path. The part file's
// own leftover part() definitions must build either way, and an imported
// part file's must not; the host must still know the real-path modules for
// its own (re-evaluated every render, scanned for blocked imports).

/** A part the file declares and never exports or inserts — a 5 × 8 cylinder — beside an imported part file. */
const MODEL = [
  `import { part, cylinder } from 'fluidcad/core';`,
  `import { plate } from './plate.part.js';`,
  ``,
  `part('Block', () => {`,
  `  cylinder(5, 8);`,
  `});`,
  ``,
].join('\n');

const PLATE_PART = [
  `import { part, cylinder } from 'fluidcad/core';`,
  ``,
  `export const plate = part('Plate', () => {`,
  `  cylinder(20, 2);`,
  `});`,
  ``,
].join('\n');

const BLOCK = Math.PI * 5 ** 2 * 8;

type Row = { type: string; name?: string; hasError?: boolean; errorMessage?: string; sceneShapes?: { shapeId: string }[] };

let scratch: string;
let real: string;
let link: string;
let host: LocalSceneHost | null;
let server: FluidCadServer;

function rowsOf(data: SceneRenderedData | null): Row[] {
  return data!.result as Row[];
}

function errorsOf(data: SceneRenderedData | null): string[] {
  return rowsOf(data).flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

function partNames(data: SceneRenderedData | null): string[] {
  return rowsOf(data).filter(row => row.type === 'part').map(row => row.name!);
}

function volumeOf(data: SceneRenderedData | null): number {
  return rowsOf(data)
    .flatMap(row => row.sceneShapes ?? [])
    .reduce((sum, shape) => sum + (server.getShapeProperties(shape.shapeId)?.volumeMm3 ?? 0), 0);
}

/** Boot a server over `workspace`. */
async function open(workspace: string): Promise<void> {
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  await server.init(workspace);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-linked-'));
  real = path.join(scratch, 'real', 'cad');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'model.part.js'), MODEL);
  fs.writeFileSync(path.join(real, 'plate.part.js'), PLATE_PART);
  fs.writeFileSync(path.join(real, 'init.js'), `import { init } from 'fluidcad'\n\nexport default await init()\n`);
  fs.writeFileSync(path.join(real, 'fluidcad.json'), JSON.stringify({ unit: 'mm' }));
  link = path.join(scratch, 'cad-link');
  fs.symlinkSync(real, link, 'junction');
  host = null;
});

afterEach(async () => {
  await host?.server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('a part file in a workspace opened through a symlink', () => {
  it('builds its own part, not the imported one, rendered from disk by the link path', async () => {
    await open(link);
    const data = await server.processFile(path.join(link, 'model.part.js'));
    expect(errorsOf(data)).toEqual([]);
    expect(partNames(data)).toEqual(['Block']);
    expect(volumeOf(data)).toBeCloseTo(BLOCK, 3);
  });

  it('builds its own part, not the imported one, rendered live by the link path', async () => {
    await open(link);
    const data = await server.updateLiveCode(path.join(link, 'model.part.js'), MODEL);
    expect(errorsOf(data)).toEqual([]);
    expect(partNames(data)).toEqual(['Block']);
    expect(volumeOf(data)).toBeCloseTo(BLOCK, 3);
  });

  it('builds its own part when a linked workspace renders the file by its real path', async () => {
    await open(link);
    const data = await server.processFile(path.join(real, 'model.part.js'));
    expect(errorsOf(data)).toEqual([]);
    expect(partNames(data)).toEqual(['Block']);
    expect(volumeOf(data)).toBeCloseTo(BLOCK, 3);
  });

  it('builds its own part when a workspace opened by its real path renders the file by the link path', async () => {
    await open(real);
    const data = await server.processFile(path.join(link, 'model.part.js'));
    expect(errorsOf(data)).toEqual([]);
    expect(partNames(data)).toEqual(['Block']);
  });

  it('stays the same on a second render from disk', async () => {
    await open(link);
    expect(partNames(await server.processFile(path.join(link, 'model.part.js')))).toEqual(['Block']);
    const second = await server.processFile(path.join(link, 'model.part.js'), true);
    expect(errorsOf(second)).toEqual([]);
    expect(partNames(second)).toEqual(['Block']);
    expect(volumeOf(second)).toBeCloseTo(BLOCK, 3);
  });

  it('refuses a workspace module that imports a blocked Node module', async () => {
    fs.writeFileSync(path.join(real, 'sizes.js'), `import { readFileSync } from 'fs';\nexport const SIZE = readFileSync.length;\n`);
    await open(link);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(server.updateLiveCode(path.join(link, 'model.part.js'), `import { SIZE } from './sizes.js';\n${MODEL}`))
        .rejects.toThrow(/Module "fs" is not allowed in FluidCAD scripts/);
    } finally {
      log.mockRestore();
    }
  });
});
