import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createParamsRouter } from '../../src/routes/params.ts';
import { createPartCatalogRouter } from '../../src/routes/part-catalog.ts';
import { createSketchEditsRouter } from '../../src/routes/sketch-edits.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';

const CODE = `import { assembly, param } from 'fluidcad/core';
export const frame = assembly('Frame', () => {
  const width = param('Width', 100);
});
`;
let server: http.Server;
let base: string;
let relayed: any[];

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('assembly parameter UI endpoints', () => {
  beforeAll(async () => {
    const backend = {
      getCurrentCode: () => CODE,
      getCurrentFileName: () => '/ws/frame.assembly.js',
    } as any;
    const send = (message: any) => { relayed.push(message); return false; };
    const dispatcher = new FeatureEditDispatcher(backend, send);
    const app = express();
    app.use(express.json());
    app.use(createParamsRouter(backend, send, () => {}, dispatcher));
    app.use(createPartCatalogRouter(backend, '/ws', dispatcher));
    app.use(createSketchEditsRouter(backend, send, '/ws', dispatcher));
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  beforeEach(() => { relayed = []; });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('creates a parameter in assembly scope through the existing edit dispatcher', async () => {
    const response = await post('/params/add', {
      assembly: true, param: { label: 'Depth', defaultValue: 50, type: 'number' },
    });
    expect(response.status).toBe(200);
    expect(relayed[0].spec.paramEdit).toMatchObject({ kind: 'add', assembly: true });
    const result = await applyFeatureEdit(CODE, relayed[0].spec);
    expect(result.newCode).toContain("const width = param('Width', 100);\n  const depth = param('Depth', 50);");
  });

  it('returns assembly parameters for Insert autocomplete', async () => {
    const response = await post('/scope-variables', { sketchSourceLine: null, assembly: true });
    expect(response.status).toBe(200);
    expect(response.body.variables).toContainEqual({ name: 'width', initializer: "param('Width', 100)", numeric: true });
  });

  it('accepts expressions alongside literal values and declarations in a batch insert', async () => {
    const response = await post('/part-catalog/insert', {
      inserts: [{ file: '/ws/beam.part.js', exportName: 'beam', kind: 'value', params: {
        Length: { expr: 'width / 2' }, Depth: { expr: 'depth' }, Color: 'blue',
      } }],
      newVariables: [{ name: 'depth', initializer: "param('Depth', 30)" }],
    });
    expect(response.status).toBe(200);
    const result = await applyFeatureEdit(CODE, relayed[0].spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain("insert(beam, { Length: width / 2, Depth: depth, Color: 'blue' })");
    expect(result.newCode).toContain("const width = param('Width', 100);\n  const depth = param('Depth', 30);");
  });

  it('rejects malformed expressions before dispatching a source edit', async () => {
    const response = await post('/part-catalog/insert', {
      inserts: [{ file: '/ws/beam.part.js', exportName: 'beam', kind: 'value', params: { Length: { expr: 'width; other()' } } }],
    });
    expect(response.status).toBe(400);
    expect(relayed).toEqual([]);
  });
});
