import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createExportRouter } from '../../src/routes/export.ts';

let server: http.Server;
let baseUrl: string;

/** Options each exportShapes call received. */
let exportCalls: Record<string, unknown>[];
/** The selection each exportShapes call received. */
let selections: unknown[];
/** What the fake engine answers a shapes export with. */
let shapesOutcome: unknown;
/** (options, livePoses) each exportAssembly call received. */
let assemblyCalls: { options: Record<string, unknown>; livePoses: unknown }[];
/** What the fake engine answers an assembly export with. */
let assemblyOutcome: unknown;

const fakeServer = {
  exportShapes: (selection: unknown, options: Record<string, unknown>) => {
    selections.push(selection);
    exportCalls.push(options);
    return shapesOutcome;
  },
  exportAssembly: (options: Record<string, unknown>, livePoses: unknown) => {
    assemblyCalls.push({ options, livePoses });
    return assemblyOutcome;
  },
};

const pose = (instanceId: string) => ({
  instanceId,
  position: { x: 1, y: 2, z: 3 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
});

async function postExport(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // binary/plain export bodies are not JSON
  }
  return { status: res.status, body: parsed };
}

describe('export route', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createExportRouter(fakeServer as any, '/ws'));

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    exportCalls = [];
    selections = [];
    shapesOutcome = { data: 'solid', fileName: 'export.stl' };
    assemblyCalls = [];
    assemblyOutcome = { ok: true, data: 'ISO-10303-21;', fileName: 'rig.step', posesSource: 'live' };
  });

  it('rejects a body with neither selector, or both', async () => {
    const neither = await postExport({ format: 'step' });
    expect(neither.status).toBe(400);
    expect(neither.body.error).toMatch(/shapeIds.*assembly/);
    const both = await postExport({ format: 'step', shapeIds: ['s1'], assembly: {} });
    expect(both.status).toBe(400);
    expect(exportCalls).toEqual([]);
    expect(assemblyCalls).toEqual([]);
  });

  it('exports the whole assembly with the client\'s live poses', async () => {
    const res = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'step', assembly: { poses: [pose('inst-0'), pose('inst-1')] }, includeColors: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-fluidcad-assembly-poses')).toBe('live');
    expect(res.headers.get('content-disposition')).toContain('filename="rig.step"');
    expect(await res.text()).toBe('ISO-10303-21;');
    expect(assemblyCalls).toHaveLength(1);
    expect(assemblyCalls[0].options.includeColors).toBe(false);
    expect(assemblyCalls[0].livePoses).toEqual([pose('inst-0'), pose('inst-1')]);
    expect(exportCalls).toEqual([]);
  });

  it('exports the assembly where the engine solves it when no poses are sent', async () => {
    assemblyOutcome = { ok: true, data: 'ISO-10303-21;', fileName: 'rig.step', posesSource: 'solved' };
    const res = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'step', assembly: {} }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-fluidcad-assembly-poses')).toBe('solved');
    expect(assemblyCalls[0].livePoses).toBeUndefined();
  });

  it('rejects malformed live poses before touching the engine', async () => {
    const { status, body } = await postExport({
      format: 'step',
      assembly: { poses: [{ instanceId: 'inst-0', position: { x: 1, y: 2 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }] },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/poses/);
    expect(assemblyCalls).toEqual([]);
  });

  it('relays the engine\'s refusal as 422', async () => {
    assemblyOutcome = { ok: false, reason: 'Exporting an assembly targets an assembly — open a *.assembly.js file first.' };
    const { status, body } = await postExport({ format: 'stl', assembly: {} });
    expect(status).toBe(422);
    expect(body.error).toMatch(/assembly\.js/);
  });

  it('answers 404 for an assembly export with nothing rendered', async () => {
    assemblyOutcome = null;
    const { status } = await postExport({ format: 'stl', assembly: {} });
    expect(status).toBe(404);
  });

  it('passes a valid STL scaleTo through', async () => {
    const { status } = await postExport({ format: 'stl', shapeIds: ['s1'], scaleTo: 'document' });
    expect(status).toBe(200);
    expect(exportCalls[0].scaleTo).toBe('document');
  });

  it('leaves scaleTo to the engine default when absent', async () => {
    const { status } = await postExport({ format: 'stl', shapeIds: ['s1'] });
    expect(status).toBe(200);
    expect('scaleTo' in exportCalls[0]).toBe(false);
  });

  it('rejects an unknown scaleTo', async () => {
    const { status, body } = await postExport({ format: 'stl', shapeIds: ['s1'], scaleTo: 'cubits' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/scaleTo/);
    expect(exportCalls).toEqual([]);
  });

  it('ignores scaleTo for STEP', async () => {
    const { status } = await postExport({ format: 'step', shapeIds: ['s1'], scaleTo: 'document' });
    expect(status).toBe(200);
    expect('scaleTo' in exportCalls[0]).toBe(false);
  });

  it('passes "all" through as the selection', async () => {
    const { status } = await postExport({ format: 'step', shapeIds: 'all' });
    expect(status).toBe(200);
    expect(selections).toEqual(['all']);
  });

  it('rejects a selector that is neither ids nor "all"', async () => {
    for (const shapeIds of ['every', [], [''], [1]]) {
      const { status, body } = await postExport({ format: 'step', shapeIds });
      expect(status).toBe(400);
      expect(body.error).toMatch(/non-empty array of shape ids, or "all"/);
    }
    expect(selections).toEqual([]);
  });

  it('relays a selection refusal with its status and the missing shapes', async () => {
    const missing = [{ shapeId: 's2', label: 'Solid 2 (Boss)' }];
    shapesOutcome = { status: 400, reason: "Configuration 'Default' does not build Solid 2 (Boss).", missing };
    const refused = await postExport({ format: 'step', shapeIds: ['s2'] });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: "Configuration 'Default' does not build Solid 2 (Boss).", missing });

    shapesOutcome = { status: 422, reason: 'The scene has no solids to export.' };
    const empty = await postExport({ format: 'step', shapeIds: 'all' });
    expect(empty.status).toBe(422);
    expect(empty.body).toEqual({ error: 'The scene has no solids to export.' });
  });

  describe('dxf — a drawing of the view on a plane', () => {
    beforeEach(() => {
      shapesOutcome = { data: '  0\r\nSECTION\r\n', fileName: 'export-top.dxf' };
    });

    it('passes the plane and the drawing options to the engine, and nothing of the 3D formats', async () => {
      const res = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'dxf', shapeIds: ['s1'], plane: 'front', hiddenLines: true, tangentEdges: false }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/vnd.dxf');
      expect(res.headers.get('x-fluidcad-export-warnings')).toBeNull();
      expect(await res.text()).toBe('  0\r\nSECTION\r\n');
      expect(exportCalls).toEqual([{ format: 'dxf', plane: 'front', hiddenLines: true, tangentEdges: false }]);
      expect(selections).toEqual([['s1']]);
    });

    it('names the file after the view, whichever name the plane was asked under', async () => {
      const names: Record<string, string> = {
        xy: 'top', top: 'top', '-xy': 'bottom', bottom: 'bottom', xz: 'front', front: 'front',
        '-xz': 'back', back: 'back', yz: 'right', right: 'right', '-yz': 'left', left: 'left',
      };
      for (const [plane, view] of Object.entries(names)) {
        const res = await fetch(`${baseUrl}/api/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'dxf', shapeIds: 'all', plane }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toBe(`attachment; filename="export-${view}.dxf"`);
      }
      expect(exportCalls.map((call) => call.plane)).toEqual(Object.keys(names));
    });

    it('refuses a missing or unknown plane with a 400 listing the accepted names', async () => {
      for (const plane of [undefined, 'iso', 'TOP', 3, null]) {
        const { status, body } = await postExport({ format: 'dxf', shapeIds: ['s1'], plane });
        expect(status).toBe(400);
        expect(body.error).toMatch(/plane must be one of xy, xz, yz, -xy, -xz, -yz, top, bottom, front, back, left, right/);
        expect(body.planes).toEqual(['xy', 'xz', 'yz', '-xy', '-xz', '-yz', 'top', 'bottom', 'front', 'back', 'left', 'right']);
      }
      expect(exportCalls).toEqual([]);
    });

    it('refuses the 3D formats\' options rather than ignoring them', async () => {
      const stray: Record<string, unknown> = {
        resolution: 'fine', customLinearDeflection: 0.1, customAngularDeflectionDeg: 10, scaleTo: 'mm', includeColors: true,
      };
      for (const [name, value] of Object.entries(stray)) {
        const { status, body } = await postExport({ format: 'dxf', shapeIds: ['s1'], plane: 'top', [name]: value });
        expect(status).toBe(400);
        expect(body.error).toContain(name);
        expect(body.error).toMatch(/not apply to a DXF drawing/);
      }
      expect(exportCalls).toEqual([]);
    });

    it('refuses a drawing option that is not a boolean', async () => {
      for (const name of ['hiddenLines', 'tangentEdges']) {
        const { status, body } = await postExport({ format: 'dxf', shapeIds: ['s1'], plane: 'top', [name]: 'yes' });
        expect(status).toBe(400);
        expect(body.error).toBe(`${name} must be a boolean.`);
      }
      expect(exportCalls).toEqual([]);
    });

    it('answers 422 for the whole assembly: it has no drawing yet', async () => {
      const { status, body } = await postExport({ format: 'dxf', plane: 'top', assembly: {} });
      expect(status).toBe(422);
      expect(body.error).toMatch(/DXF drawing of the whole assembly is not available yet/);
      expect(assemblyCalls).toEqual([]);
      expect(exportCalls).toEqual([]);
    });

    it('carries the drawing\'s warnings in a header, URI-encoded JSON', async () => {
      const warnings = ['2 curves were approximated by polylines: the kernel could not hand them over as splines.', 'größer — ünïcode'];
      shapesOutcome = { data: 'dxf', fileName: 'export-top.dxf', warnings };
      const res = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'dxf', shapeIds: ['s1'], plane: 'top' }),
      });
      expect(res.status).toBe(200);
      const header = res.headers.get('x-fluidcad-export-warnings');
      expect(header).not.toBeNull();
      expect(JSON.parse(decodeURIComponent(header!))).toEqual(warnings);
    });

    it('writes the drawing inside the workspace with saveAsPath, the warnings beside savedTo', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-export-route-')));
      const app = express();
      app.use(express.json());
      app.use('/api', createExportRouter(fakeServer as any, dir));
      const scoped = http.createServer(app);
      await new Promise<void>((resolve) => scoped.listen(0, '127.0.0.1', () => resolve()));
      const addr = scoped.address();
      const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      try {
        const post = async (body: unknown) => {
          const res = await fetch(`${url}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return { status: res.status, body: await res.json() as any };
        };
        const plain = await post({ format: 'dxf', shapeIds: ['s1'], plane: 'top', saveAsPath: 'plate-top.dxf' });
        expect(plain.status).toBe(200);
        expect(plain.body).toEqual({ savedTo: join(dir, 'plate-top.dxf'), bytesWritten: 14 });
        expect(readFileSync(join(dir, 'plate-top.dxf'), 'utf8')).toBe('  0\r\nSECTION\r\n');

        shapesOutcome = { data: 'dxf', fileName: 'export-top.dxf', warnings: ['1 curve was approximated by polylines.'] };
        const warned = await post({ format: 'dxf', shapeIds: ['s1'], plane: 'top', saveAsPath: 'warned.dxf' });
        expect(warned.body.warnings).toEqual(['1 curve was approximated by polylines.']);
      } finally {
        await new Promise<void>((resolve) => scoped.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('relays a selection refusal as for the 3D formats', async () => {
      shapesOutcome = { status: 422, reason: 'The scene has no solids to export.' };
      const { status, body } = await postExport({ format: 'dxf', shapeIds: 'all', plane: 'top' });
      expect(status).toBe(422);
      expect(body).toEqual({ error: 'The scene has no solids to export.' });
    });
  });

  describe('svg — the same drawing on a page', () => {
    const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>\n';

    beforeEach(() => {
      shapesOutcome = { data: SVG, fileName: 'export-top.svg' };
    });

    it('passes the plane, the drawing options and the page options to the engine', async () => {
      const res = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'svg', shapeIds: ['s1'], plane: 'front', hiddenLines: true, tangentEdges: false, strokeWidth: 0.5, margin: 0 }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="export-front.svg"');
      expect(res.headers.get('x-fluidcad-export-warnings')).toBeNull();
      expect(await res.text()).toBe(SVG);
      // The flat body fields reach the engine as its `svg` page options.
      expect(exportCalls).toEqual([{ format: 'svg', plane: 'front', hiddenLines: true, tangentEdges: false, svg: { strokeWidth: 0.5, margin: 0 } }]);
      expect(selections).toEqual([['s1']]);
    });

    it('leaves the page to the engine\'s defaults when the body names neither option', async () => {
      await postExport({ format: 'svg', shapeIds: 'all', plane: 'top' });
      await postExport({ format: 'svg', shapeIds: 'all', plane: 'top', margin: 2 });
      expect(exportCalls).toEqual([
        { format: 'svg', plane: 'top' },
        { format: 'svg', plane: 'top', svg: { margin: 2 } },
      ]);
    });

    it('names the file after the view, whichever name the plane was asked under', async () => {
      const names: Record<string, string> = { xy: 'top', '-xy': 'bottom', front: 'front', '-xz': 'back', yz: 'right', left: 'left' };
      for (const [plane, view] of Object.entries(names)) {
        const res = await fetch(`${baseUrl}/api/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'svg', shapeIds: 'all', plane }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toBe(`attachment; filename="export-${view}.svg"`);
      }
    });

    it('refuses a missing or unknown plane with a 400 listing the accepted names', async () => {
      for (const plane of [undefined, 'iso', 3]) {
        const { status, body } = await postExport({ format: 'svg', shapeIds: ['s1'], plane });
        expect(status).toBe(400);
        expect(body.error).toMatch(/^SVG draws the model's view on a plane: plane must be one of xy, xz, yz/);
        expect(body.planes).toHaveLength(12);
      }
      expect(exportCalls).toEqual([]);
    });

    it('refuses a stroke width that is not a positive number, and a margin that is not zero or more', async () => {
      for (const strokeWidth of [0, -0.25, '0.25', null, true]) {
        const { status, body } = await postExport({ format: 'svg', shapeIds: ['s1'], plane: 'top', strokeWidth });
        expect(status).toBe(400);
        expect(body.error).toBe('strokeWidth must be a number of millimetres greater than 0.');
      }
      for (const margin of [-1, '5', null, false]) {
        const { status, body } = await postExport({ format: 'svg', shapeIds: ['s1'], plane: 'top', margin });
        expect(status).toBe(400);
        expect(body.error).toBe('margin must be a number of millimetres, 0 or more.');
      }
      expect(exportCalls).toEqual([]);
    });

    it('refuses the 3D formats\' options rather than ignoring them', async () => {
      const stray: Record<string, unknown> = {
        resolution: 'fine', customLinearDeflection: 0.1, customAngularDeflectionDeg: 10, scaleTo: 'mm', includeColors: true,
      };
      for (const [name, value] of Object.entries(stray)) {
        const { status, body } = await postExport({ format: 'svg', shapeIds: ['s1'], plane: 'top', [name]: value });
        expect(status).toBe(400);
        expect(body.error).toContain(name);
        expect(body.error).toMatch(/not apply to a SVG drawing/);
      }
      expect(exportCalls).toEqual([]);
    });

    it('refuses the page options on every other format', async () => {
      shapesOutcome = { data: 'x', fileName: 'export.step' };
      const bodies: Record<string, unknown>[] = [
        { format: 'dxf', shapeIds: ['s1'], plane: 'top' },
        { format: 'step', shapeIds: ['s1'] },
        { format: 'stl', shapeIds: ['s1'] },
      ];
      for (const base of bodies) {
        for (const [name, value] of [['strokeWidth', 0.5], ['margin', 2]] as const) {
          const { status, body } = await postExport({ ...base, [name]: value });
          expect(status).toBe(400);
          expect(body.error).toBe(`${name} applies to an SVG drawing only, not to ${String(base.format).toUpperCase()}.`);
        }
      }
      const both = await postExport({ format: 'stl', shapeIds: ['s1'], strokeWidth: 0.5, margin: 2 });
      expect(both.body.error).toBe('strokeWidth, margin apply to an SVG drawing only, not to STL.');
      expect(exportCalls).toEqual([]);
    });

    it('answers 422 for the whole assembly: it has no drawing yet', async () => {
      const { status, body } = await postExport({ format: 'svg', plane: 'top', assembly: {} });
      expect(status).toBe(422);
      expect(body.error).toMatch(/SVG drawing of the whole assembly is not available yet/);
      expect(assemblyCalls).toEqual([]);
      expect(exportCalls).toEqual([]);
    });

    it('carries the drawing\'s warnings in the same header as DXF', async () => {
      const warnings = ['2 curves were approximated by polylines: the kernel could not hand them over as splines.'];
      shapesOutcome = { data: SVG, fileName: 'export-top.svg', warnings };
      const res = await fetch(`${baseUrl}/api/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'svg', shapeIds: ['s1'], plane: 'top' }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(decodeURIComponent(res.headers.get('x-fluidcad-export-warnings')!))).toEqual(warnings);
    });
  });

  it('names the four formats when the format is none of them', async () => {
    const { status, body } = await postExport({ format: 'pdf', shapeIds: ['s1'], plane: 'top' });
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid format. Must be "step", "stl", "dxf" or "svg".');
  });

  it('never lets the client assert the shapes\' unit', async () => {
    await postExport({ format: 'step', shapeIds: ['s1'], unit: 'in' });
    expect('unit' in exportCalls[0]).toBe(false);
  });
});
