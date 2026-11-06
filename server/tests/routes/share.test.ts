import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { createShareRouter, type ShareFilesResponse } from '../../src/routes/share.ts';
import type { SceneRenderedData } from '../../src/fluidcad-server/render-types.ts';

// GET /api/share-files over a real render: a model that load()s an imported
// STEP file ships the `.brep` cache and its sidecars beside its modules —
// read off what the render read, so an assembly whose inserted part does the
// load() ships them too, and an import nothing loads stays home.

const BLOCK_PART = [
  `import { part, cylinder } from 'fluidcad/core';`,
  ``,
  `export const block = part('Block', () => {`,
  `  cylinder(10, 4);`,
  `});`,
  ``,
].join('\n');

const MOTOR_PART = [
  `import { part, load } from 'fluidcad/core';`,
  ``,
  `export const motor = part('Motor', () => {`,
  `  load('motor.step');`,
  `});`,
  ``,
].join('\n');

const RIG_ASSEMBLY = [
  `import { assembly, insert } from 'fluidcad/core';`,
  `import { motor } from './motor.part.js';`,
  ``,
  `export const rig = assembly('Rig', () => {`,
  `  insert(motor);`,
  `});`,
  ``,
].join('\n');

const MOTOR_ASSETS = ['imports/motor.brep', 'imports/motor.colors.json', 'imports/motor.import.json'];

let workspace: string;
let host: LocalSceneHost;
let server: FluidCadServer;
let http_: http.Server;
let baseUrl: string;

const at = (rel: string) => path.join(workspace, rel);

function errorsOf(data: SceneRenderedData | null): string[] {
  const rows = data!.result as { type: string; hasError?: boolean; errorMessage?: string }[];
  return rows.flatMap(row => row.hasError ? [`${row.type}: ${row.errorMessage}`] : []);
}

async function shareFiles(): Promise<ShareFilesResponse> {
  const res = await fetch(`${baseUrl}/api/share-files`);
  expect(res.status).toBe(200);
  return res.json() as Promise<ShareFilesResponse>;
}

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-share-'));
  fs.writeFileSync(at('init.js'), `import { init } from 'fluidcad'\n\nexport default await init()\n`);
  fs.writeFileSync(at('block.part.js'), BLOCK_PART);
  host = new LocalSceneHost();
  server = new FluidCadServer(host);
  // The test files share one engine (init() hands back the one that
  // exists): the server roots it here, wherever it was first made.
  await server.init(workspace);

  // A STEP file to import: the block, exported, then imported as motor.step.
  const block = await server.processFile(at('block.part.js'));
  expect(errorsOf(block)).toEqual([]);
  const step = server.exportShapes('all', { format: 'step' });
  if (!step || !('data' in step)) {
    throw new Error('the block did not export');
  }
  await server.importFile(workspace, 'motor.step', Buffer.from(step.data as string).toString('base64'));
  fs.copyFileSync(at('imports/motor.brep'), at('imports/spare.brep'));
  fs.writeFileSync(at('motor.part.js'), MOTOR_PART);
  fs.writeFileSync(at('rig.assembly.js'), RIG_ASSEMBLY);

  const app = express();
  app.use('/api', createShareRouter(server, workspace, '0.0.48'));
  http_ = http.createServer(app);
  await new Promise<void>((resolve) => {
    http_.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = http_.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http_?.close(() => resolve()));
  await host?.server.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('GET /api/share-files — imported geometry travels with the model', () => {
  it('ships the .brep and its sidecars a part file loads, and no other import', async () => {
    const data = await server.processFile(at('motor.part.js'));
    expect(errorsOf(data)).toEqual([]);

    const share = await shareFiles();

    expect(share.entry).toBe('motor.part.js');
    expect(Object.keys(share.files).sort()).toEqual([...MOTOR_ASSETS, 'init.js', 'motor.part.js']);
    for (const asset of MOTOR_ASSETS) {
      expect(share.files[asset]).toBe(fs.readFileSync(at(asset), 'utf8'));
    }
  });

  it('ships the assets an inserted part loads when the assembly is shared', async () => {
    const data = await server.processFile(at('rig.assembly.js'));
    expect(errorsOf(data)).toEqual([]);

    const share = await shareFiles();

    expect(share.entry).toBe('rig.assembly.js');
    expect(Object.keys(share.files).sort()).toEqual([...MOTOR_ASSETS, 'init.js', 'motor.part.js', 'rig.assembly.js']);
  });

  it('ships no assets for a model that loads none', async () => {
    const data = await server.processFile(at('block.part.js'));
    expect(errorsOf(data)).toEqual([]);

    const share = await shareFiles();

    expect(Object.keys(share.files).sort()).toEqual(['block.part.js', 'init.js']);
  });
});
