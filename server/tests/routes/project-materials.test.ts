// The Manage materials… dialog's server side: POST /project/materials
// validates the whole map like fluidcad.json is read, merges it into the
// file keeping every other key, refreshes the server's copy, recomputes the
// current file, and answers the merged built-in + project list.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createProjectMaterialsRouter } from '../../src/routes/project-materials.ts';
import { readProjectConfig } from '../../src/project-config.ts';

let server: http.Server;
let baseUrl: string;
let workspace: string;
let relayed: any[];
let broadcast: any[];
let recomputes: boolean[];
let reloads: number;
/** What the fake server answers a recompute with; null = nothing rendered yet. */
let sceneData: any;

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/project/materials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function readConfigFile(): any {
  return JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8'));
}

describe('POST /project/materials', () => {
  beforeAll(async () => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-materials-')));
    const app = express();
    app.use(express.json());
    app.use('/api', createProjectMaterialsRouter({
      workspacePath: workspace,
      fluidCadServer: {
        recomputeCurrentFile: async (force?: boolean) => {
          recomputes.push(force === true);
          return sceneData;
        },
        reloadProjectMaterials: () => { reloads += 1; },
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
    reloads = 0;
    sceneData = null;
    fs.rmSync(path.join(workspace, 'fluidcad.json'), { force: true });
  });

  it('writes the map into fluidcad.json keeping unknown keys, and answers the merged list', async () => {
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify({ engine: '0.0.1', unit: 'in', modelId: 'm1', custom: { keep: true } }));
    const materials = {
      'alloy-steel': { name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³' },
      'fluidcad-pla': { name: 'House PLA', density: 1300, densityUnit: 'kg/m³' },
    };

    const { status, body } = await post({ materials });

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, recomputed: false, configPath: path.join(workspace, 'fluidcad.json') });
    expect(readConfigFile()).toEqual({ engine: '0.0.1', unit: 'in', modelId: 'm1', custom: { keep: true }, materials });
    expect(readProjectConfig(workspace).materials).toEqual(materials);
    expect(reloads).toBe(1);
    expect(recomputes).toEqual([true]);

    const list: any[] = body.materials;
    // Built-ins first; the project's override of a built-in id replaces it in place.
    expect(list[0].source).toBe('builtin');
    expect(list.filter((m) => m.id === 'fluidcad-pla')).toEqual([
      { id: 'fluidcad-pla', name: 'House PLA', density: 1300, densityUnit: 'kg/m³', source: 'project' },
    ]);
    expect(list[list.length - 1]).toEqual({ id: 'alloy-steel', name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³', source: 'project' });
    expect(list.filter((m) => m.source === 'project')).toHaveLength(2);
  });

  it('an empty map clears the project entries and leaves the built-ins', async () => {
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify({ unit: 'mm', materials: { pine: { name: 'Pine', density: 0.5 } } }));
    const { status, body } = await post({ materials: {} });
    expect(status).toBe(200);
    expect(readConfigFile()).toEqual({ unit: 'mm', materials: {} });
    expect(body.materials.every((m: any) => m.source === 'builtin')).toBe(true);
  });

  it('recomputes and fans the scene out to the host and the UI, warnings included', async () => {
    sceneData = {
      absPath: '/ws/bracket.part.js', sceneKind: 'part', unit: 'mm', declaredUnit: null, projectUnit: 'mm',
      result: [], rollbackStop: -1, breakpointHit: false, objectErrors: [], objectWarnings: [],
      params: [], properties: [],
    };
    const { status, body } = await post({ materials: { pine: { name: 'Pine', density: 0.5 } } });
    expect(status).toBe(200);
    expect(body.recomputed).toBe(true);
    expect(relayed.map((m) => m.type)).toEqual(['scene-rendered']);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({ type: 'scene-rendered', absPath: '/ws/bracket.part.js', objectWarnings: [] });
  });

  it.each([
    ['a missing map', {}, 'not a map'],
    ['a non-object map', { materials: ['x'] }, 'not a map'],
    ['an empty id', { materials: { '': { name: 'X', density: 1 } } }, 'empty id'],
    ['a missing name', { materials: { x: { density: 1 } } }, 'without a "name"'],
    ['a zero density', { materials: { x: { name: 'X', density: 0 } } }, '"density" is not a positive number'],
    ['a bad density unit', { materials: { x: { name: 'X', density: 1, densityUnit: 'stone/ft³' } } }, '"densityUnit"'],
  ])('refuses %s with 400 without writing or recomputing', async (_label, payload, fragment) => {
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify({ unit: 'mm' }));
    const { status, body } = await post(payload);
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.reason).toContain('"materials"');
    expect(body.reason).toContain(fragment);
    expect(readConfigFile()).toEqual({ unit: 'mm' });
    expect(recomputes).toEqual([]);
    expect(reloads).toBe(0);
  });
});

describe('POST /project/materials without a workspace', () => {
  it('answers 409', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createProjectMaterialsRouter({
      workspacePath: '',
      fluidCadServer: { recomputeCurrentFile: async () => null, reloadProjectMaterials: () => undefined },
      sendToExtension: () => true,
      broadcastToUI: () => undefined,
    }));
    const srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/project/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ materials: { pine: { name: 'Pine', density: 0.5 } } }),
    });
    expect(res.status).toBe(409);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});
