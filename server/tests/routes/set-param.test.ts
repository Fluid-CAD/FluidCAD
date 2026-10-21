// POST /api/set-param is the Parameters panel's value edit. A parameter is
// its part + label: in a file whose Plate and Lid both declare `Width`, the
// panel names the part (`body`) and only that part's Width changes. A request
// by label alone (an older client) still works while one part declares the
// label, and is refused — never applied to both — when several do.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { createParamsRouter } from '../../src/routes/params.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import type { SceneHost } from '../../src/host/scene-host.ts';
import { createManager, getSceneManager } from '../../../lib/dist/scene-manager.js';
import param from '../../../lib/dist/core/param.js';
import part from '../../../lib/dist/core/part.js';

const FILE = '/ws/pair.part.js';

/**
 * Stands in for the Vite host: the buffer's `part("Name") { param("L", n) … }`
 * blocks become part bodies declaring those params, run as an attributed
 * module of the file (see `param-overrides.test.ts`).
 */
class FakeHost implements SceneHost {
  buffers = new Map<string, string>();

  async init(): Promise<void> {}

  async loadModule(filePath: string): Promise<Record<string, any>> {
    const code = this.buffers.get(filePath) ?? '';
    const scene = (getSceneManager() ?? createManager('')).startScene();
    const lines: string[] = [];
    for (const block of code.matchAll(/part\("([^"]+)"\)\s*\{([^}]*)\}/g)) {
      lines.push(`part(${JSON.stringify(block[1])}, () => {`);
      for (const m of block[2].matchAll(/param\("([^"]+)",\s*([\d.]+)\)/g)) {
        lines.push(`  param(${JSON.stringify(m[1])}, ${Number(m[2])});`);
      }
      lines.push('});');
    }
    new Function('part', 'param', `"use strict";\n${lines.join('\n')}\n//# sourceURL=${filePath}`)(part, param);
    scene.materializeLeftoverDefinitions();
    return {};
  }

  setBuffer(id: string, code: string): void {
    this.buffers.set(id, code);
  }

  getBuffer(fileName: string): string | null {
    return this.buffers.get(fileName) ?? null;
  }

  invalidateModule(): void {}
}

const fakeSceneManager = () => ({
  startScene: () => ({ getRenderedObjects: () => [], getAllSceneObjects: () => [] }),
  setCurrentFile: () => {},
  renderScene: () => {},
  compare: (_prev: any, next: any) => next,
  getAssemblyData: () => null,
});

const TWO_PARTS = [
  `part("Plate") { param("Width", 100); param("Depth", 5) }`,
  `part("Lid") { param("Width", 40) }`,
].join('\n');

let http_: http.Server;
let baseUrl: string;
let fluid: FluidCadServer;
let broadcast: any[];

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** `body/label → currentValue` of the last render the route broadcast. */
function lastValues(): Record<string, unknown> {
  const params: { body?: string; label: string; currentValue: unknown }[] = broadcast.at(-1)?.params ?? [];
  return Object.fromEntries(params.map((p) => [`${p.body}/${p.label}`, p.currentValue]));
}

describe('POST /api/set-param', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    fluid = new FluidCadServer(new FakeHost());
    fluid.setSceneManager(fakeSceneManager() as any);
    const dispatcher = new FeatureEditDispatcher(fluid as any, () => true, { ackTimeoutMs: 500 });
    app.use('/api', createParamsRouter(fluid, () => {}, (msg) => broadcast.push(msg), dispatcher));
    http_ = http.createServer(app);
    await new Promise<void>((resolve) => http_.listen(0, '127.0.0.1', () => resolve()));
    const addr = http_.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => http_.close(() => resolve()));
  });

  beforeEach(async () => {
    broadcast = [];
    fluid.resetParams(FILE);
    await fluid.updateLiveCode(FILE, TWO_PARTS);
  });

  it("sets the named part's Width and leaves the other part's alone", async () => {
    const res = await post('/set-param', { label: 'Width', value: 60, body: 'Lid' });
    expect(res.status).toBe(200);
    expect(lastValues()).toEqual({ 'Plate/Width': 100, 'Plate/Depth': 5, 'Lid/Width': 60 });

    await post('/set-param', { label: 'Width', value: 120, body: 'Plate' });
    expect(lastValues()).toEqual({ 'Plate/Width': 120, 'Plate/Depth': 5, 'Lid/Width': 60 });
  });

  it('refuses a label two parts declare when no part is named, changing nothing', async () => {
    const res = await post('/set-param', { label: 'Width', value: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Parameter 'Width' is declared by 'Plate' and 'Lid' — name the part (body) whose parameter to set.",
    );
    expect(broadcast).toEqual([]);
    expect(fluid.getParamOverrides(FILE)).toEqual({});
  });

  it('takes a label only one part declares, as an older client sends it', async () => {
    const res = await post('/set-param', { label: 'Depth', value: 9 });
    expect(res.status).toBe(200);
    expect(lastValues()).toEqual({ 'Plate/Width': 100, 'Plate/Depth': 9, 'Lid/Width': 40 });
  });

  it('refuses a body that is not a name', async () => {
    const res = await post('/set-param', { label: 'Width', value: 60, body: 7 });
    expect(res.status).toBe(400);
    expect(broadcast).toEqual([]);
  });

  it('resets every part', async () => {
    await post('/set-param', { label: 'Width', value: 60, body: 'Lid' });
    await post('/set-param', { label: 'Depth', value: 9, body: 'Plate' });
    const res = await post('/reset-params', {});
    expect(res.status).toBe(200);
    expect(lastValues()).toEqual({ 'Plate/Width': 100, 'Plate/Depth': 5, 'Lid/Width': 40 });
  });

  it('sets a single-part file by label, as it always did', async () => {
    await fluid.updateLiveCode(FILE, `part("Plate") { param("Width", 100) }`);
    const res = await post('/set-param', { label: 'Width', value: 80 });
    expect(res.status).toBe(200);
    expect(lastValues()).toEqual({ 'Plate/Width': 80 });
    expect(fluid.getParamOverrides(FILE)).toEqual({ Width: 80 });
  });
});
