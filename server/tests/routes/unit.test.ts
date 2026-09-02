// The unit chip's server side: the pure set-unit transform every editor host
// round-trips through, the relay that hands a part file's unit change to the
// host, and the project-unit write that assemblies use instead.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createUnitRouter } from '../../src/routes/unit.ts';
import { readProjectConfig } from '../../src/project-config.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let relayed: any[];
let broadcast: any[];
let recomputes: boolean[];
/** What the fake server answers a recompute with; null = nothing rendered yet. */
let sceneData: any;

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('unit routes', () => {
  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-unit-')));
    const app = express();
    app.use(express.json());
    app.use('/api', createUnitRouter({
      workspacePath: workspace,
      fluidCadServer: {
        recomputeCurrentFile: async (force?: boolean) => {
          recomputes.push(force === true);
          return sceneData;
        },
      },
      sendToExtension: (msg) => { relayed.push(msg); return true; },
      broadcastToUI: (msg) => { broadcast.push(msg); },
    }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    relayed = [];
    broadcast = [];
    recomputes = [];
    sceneData = null;
    fs.rmSync(path.join(workspace, 'fluidcad.json'), { force: true });
  });

  describe('POST /code/set-unit', () => {
    it('returns the rewritten source', async () => {
      const { status, body } = await post('/code/set-unit', {
        code: `import { extrude } from 'fluidcad/core';\nextrude(1);\n`,
        unit: 'in',
        filePath: '/ws/a.part.js',
      });
      expect(status).toBe(200);
      expect(body.newCode).toBe(`import { unit, extrude } from 'fluidcad/core';\nunit('in');\nextrude(1);\n`);
    });

    it('accepts unit: null and removes the declaration', async () => {
      const { status, body } = await post('/code/set-unit', {
        code: `import { unit, extrude } from 'fluidcad/core';\nunit('in');\nextrude(1);\n`,
        unit: null,
        filePath: '/ws/a.part.js',
      });
      expect(status).toBe(200);
      expect(body.newCode).toBe(`import { extrude } from 'fluidcad/core';\nextrude(1);\n`);
    });

    it('refuses an assembly file with 422 so no host applies it', async () => {
      const { status, body } = await post('/code/set-unit', { code: `// asm\n`, unit: 'in', filePath: '/ws/a.assembly.js' });
      expect(status).toBe(422);
      expect(body.error).toMatch(/assembly/);
    });

    it('rejects a malformed body', async () => {
      expect((await post('/code/set-unit', { unit: 'in' })).status).toBe(400);
      expect((await post('/code/set-unit', { code: '', unit: 3 })).status).toBe(400);
    });
  });

  describe('POST /set-unit', () => {
    it('relays a set-unit message naming the file to the editor host', async () => {
      const { status, body } = await post('/set-unit', { filePath: '/ws/a.part.js', unit: 'inches' });
      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(relayed).toEqual([{ type: 'set-unit', filePath: '/ws/a.part.js', unit: 'in' }]);
    });

    it('relays unit: null as null — the "Same as project" pick', async () => {
      const { status, body } = await post('/set-unit', { filePath: '/ws/a.part.js', unit: null });
      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(relayed).toEqual([{ type: 'set-unit', filePath: '/ws/a.part.js', unit: null }]);
    });

    it('refuses an assembly file or an unknown unit before relaying', async () => {
      const asm = await post('/set-unit', { filePath: '/ws/a.assembly.js', unit: 'in' });
      expect(asm.status).toBe(422);
      expect(asm.body.reason).toMatch(/assembly/);
      const bad = await post('/set-unit', { filePath: '/ws/a.part.js', unit: 'parsec' });
      expect(bad.status).toBe(422);
      expect(relayed).toEqual([]);
    });
  });

  describe('POST /project/unit', () => {
    it('writes fluidcad.json, keeps other keys, and recomputes the current file', async () => {
      fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify({ engine: '0.0.1', unit: 'mm' }));
      sceneData = {
        absPath: '/ws/robot.assembly.js', sceneKind: 'assembly', unit: 'in', declaredUnit: null, projectUnit: 'in',
        result: [], rollbackStop: -1, breakpointHit: false, objectErrors: [], assembly: { instances: [], mates: [] },
      };
      const { status, body } = await post('/project/unit', { unit: 'in' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, unit: 'in', recomputed: true });
      expect(readProjectConfig(workspace)).toMatchObject({ engine: '0.0.1', unit: 'in' });
      expect(recomputes).toEqual([true]);
      expect(relayed.map((m) => m.type)).toEqual(['scene-rendered']);
      // Both fan-outs carry the unit trio the chip's menu is built from.
      expect(relayed[0]).toMatchObject({ unit: 'in', declaredUnit: null, projectUnit: 'in' });
      expect(broadcast).toHaveLength(1);
      expect(broadcast[0]).toMatchObject({ type: 'scene-rendered', unit: 'in', declaredUnit: null, projectUnit: 'in', sceneKind: 'assembly' });
    });

    it('still writes the file when nothing has rendered yet', async () => {
      const { status, body } = await post('/project/unit', { unit: 'ft' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, unit: 'ft', recomputed: false });
      expect(readProjectConfig(workspace).unit).toBe('ft');
      expect(broadcast).toEqual([]);
    });

    it('refuses an unknown unit without writing', async () => {
      const { status } = await post('/project/unit', { unit: 'cubit' });
      expect(status).toBe(422);
      expect(fs.existsSync(path.join(workspace, 'fluidcad.json'))).toBe(false);
    });
  });
});
