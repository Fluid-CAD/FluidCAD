import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.ts';
import { registryFilePath } from '../src/discovery.ts';
import {
  getCameraState,
  screenshot,
  screenshotMulti,
  screenshotShape,
} from '../src/tools/screenshot.ts';
import { measure } from '../src/tools/inspection.ts';
import { MeasureImage } from '../src/tools/measure-image.ts';
import type { RegistryEntry } from '../src/types.ts';

// Smallest valid PNG: 1×1 transparent pixel.
const ONE_PIXEL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
  'hex',
);

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let fakePort = 0;
let lastRequest: { method: string; url: string; body: string } | null = null;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-mcp-shot',
    port: fakePort,
    pid: process.pid,
    version: '0.0.33',
    startedAt: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

function writeRegistry(entries: RegistryEntry[]): void {
  const dir = path.dirname(registryFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({ schemaVersion: 1, instances: entries }));
}

function startFakeServer(
  routes: Record<
    string,
    (req: http.IncomingMessage, body: string) => { status: number; contentType: string; body: Buffer | string } | null
  >,
): Promise<number> {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        lastRequest = { method: req.method ?? '', url: req.url ?? '', body };
        const url = (req.url ?? '').split('?')[0];
        if (url === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              version: '0.0.33',
              workspacePath: '/tmp/ws-mcp-shot',
              startedAt: 'x',
              pid: process.pid,
            }),
          );
          return;
        }
        const handler = routes[url];
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const result = handler(req, body);
        if (!result) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no result' }));
          return;
        }
        res.writeHead(result.status, { 'content-type': result.contentType });
        res.end(result.body);
      });
    });
    fakeServer.listen(0, '127.0.0.1', () => {
      const addr = fakeServer!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-shot-test-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  lastRequest = null;
});

afterEach(async () => {
  homeSpy.mockRestore();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  if (fakeServer) {
    await new Promise<void>((resolve) => fakeServer!.close(() => resolve()));
    fakeServer = null;
  }
});

describe('screenshot tools (unit)', () => {
  it('rejects an invalid view kind without contacting the server', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': () => ({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
    });
    writeRegistry([entry()]);

    const result = await screenshot({ view: { kind: 'unknown' as any } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
    expect(lastRequest).toBeNull();
  });

  it('screenshot posts the validated body and returns base64 PNG', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': (_req, body) => {
        const parsed = JSON.parse(body);
        if (parsed.view?.kind !== 'named' || parsed.view?.name !== 'iso-ftr') {
          return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad view' }) };
        }
        return { status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG };
      },
    });
    writeRegistry([entry()]);

    const result = await screenshot({
      view: { kind: 'named', name: 'iso-ftr' },
      width: 400,
      height: 400,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.image.mimeType).toBe('image/png');
    expect(result.data.image.base64).toBe(ONE_PIXEL_PNG.toString('base64'));
    expect(lastRequest?.url).toBe('/api/screenshot');
    expect(lastRequest?.method).toBe('POST');
  });

  it('screenshot_multi adds multi:true to the body', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': (_req, body) => {
        const parsed = JSON.parse(body);
        if (parsed.multi !== true) {
          return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'missing multi' }) };
        }
        return { status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG };
      },
    });
    writeRegistry([entry()]);

    const result = await screenshotMulti({ width: 800, height: 800 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.image.base64).toBe(ONE_PIXEL_PNG.toString('base64'));
  });

  it('screenshot_shape fetches the bounding box and frames it with a look-from view', async () => {
    let postedView: any = null;
    fakePort = await startFakeServer({
      '/api/shape-properties': () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          volume: 1000,
          boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
        }),
      }),
      '/api/screenshot': (_req, body) => {
        postedView = JSON.parse(body).view;
        return { status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG };
      },
    });
    writeRegistry([entry()]);

    const result = await screenshotShape({ shapeId: 'sh-1', margin: 1.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(postedView).not.toBeNull();
    expect(postedView.kind).toBe('look-from');
    expect(postedView.target).toEqual([5, 5, 5]);
    // Iso-ftr direction with positive distance: eye-x > center, eye-y < center, eye-z > center.
    expect(postedView.eye[0]).toBeGreaterThan(5);
    expect(postedView.eye[1]).toBeLessThan(5);
    expect(postedView.eye[2]).toBeGreaterThan(5);
  });

  it('screenshot_shape rejects an empty shapeId', async () => {
    const result = await screenshotShape({ shapeId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_camera_state forwards the cached payload', async () => {
    fakePort = await startFakeServer({
      '/api/camera/state': () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'camera-state',
          position: [50, -50, 40],
          target: [0, 0, 0],
          up: [0, 0, 1],
          projection: 'orthographic',
        }),
      }),
    });
    writeRegistry([entry()]);

    const result = await getCameraState({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.position).toEqual([50, -50, 40]);
    expect(result.data.projection).toBe('orthographic');
  });

  it('http errors are surfaced with code=http-error and the status code', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': () => ({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No UI client connected.' }),
      }),
    });
    writeRegistry([entry()]);

    const result = await screenshot({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect((result.details as any)?.statusCode).toBe(503);
  });
});

describe('screenshot tools (over MCP)', () => {
  it('image results are rendered as MCP image content blocks', async () => {
    fakePort = await startFakeServer({
      '/api/screenshot': () => ({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
    });
    writeRegistry([entry()]);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'screenshot',
        arguments: { workspace: '/tmp/ws-mcp-shot', view: { kind: 'named', name: 'front' } },
      });
      expect(result.isError).not.toBe(true);
      const block = (result.content as any[])[0];
      expect(block.type).toBe('image');
      expect(block.mimeType).toBe('image/png');
      expect(block.data).toBe(ONE_PIXEL_PNG.toString('base64'));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the four screenshot tools are exposed in the tool list', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of ['screenshot', 'screenshot_multi', 'screenshot_shape', 'get_camera_state']) {
        expect(names.has(expected)).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('screenshot overlays', () => {
  const BBOX = { boundingBox: { min: [0, 0, 0], max: [10, 10, 10] } };

  function pngServer(): Promise<number> {
    return startFakeServer({
      '/api/screenshot': () => ({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
      '/api/shape-properties': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(BBOX) }),
    });
  }

  it('screenshot posts highlight, hide, annotations and fitTo through to the server', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const highlight = [
      { expression: 'face().cylinder()', scope: { part: 'base' } },
      { shapeId: 'sh-1', kind: 'edge' as const, index: 2, instanceId: 'inst-1' },
    ];
    const annotations = [{ from: [0, 0, 0] as [number, number, number], to: [5, 0, 0] as [number, number, number], label: '5 mm' }];
    const result = await screenshot({ highlight, hide: ['sh-7'], annotations, fitTo: 'highlight', view: { kind: 'named', name: 'top' } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({
      view: { kind: 'named', name: 'top' },
      highlight,
      hide: ['sh-7'],
      annotations,
      fitTo: 'highlight',
    });
  });

  it('screenshot posts a section through to the server, and screenshot_multi applies it to the grid', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const result = await screenshot({ section: { plane: 'xy', offset: 10 }, view: { kind: 'named', name: 'top' } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ view: { kind: 'named', name: 'top' }, section: { plane: 'xy', offset: 10 } });

    const explicit = { plane: { origin: [0, 5, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] }, flip: true };
    const multi = await screenshotMulti({ section: explicit });
    expect(multi.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ multi: true, section: explicit });

    const shape = await screenshotShape({ shapeId: 'sh-1', section: { plane: 'yz' } });
    expect(shape.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body).section).toEqual({ plane: 'yz' });
  });

  it('rejects a malformed section without contacting the server', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const cases: Array<[unknown, string]> = [
      ['xy', '`section` must be an object'],
      [{ plane: 'ab' }, '`section.plane`'],
      [{ plane: { origin: [0, 0, 0], normal: [0, 0, 0] } }, 'zero vector'],
      [{ plane: { origin: [0, 0], normal: [0, 0, 1] } }, '`section.plane.origin`'],
      [{ plane: 'xy', offset: 'far' }, '`section.offset`'],
      [{ plane: 'xy', flip: 0 }, '`section.flip`'],
    ];
    for (const [section, expected] of cases) {
      const result = await screenshot({ section } as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid-input');
        expect(result.message).toContain(expected);
      }
    }
    expect(lastRequest).toBeNull();
  });

  it('screenshot_shape carries the overlays beside its framing view', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const result = await screenshotShape({ shapeId: 'sh-1', focus: ['sh-1'], highlight: [{ shapeId: 'sh-1', kind: 'face', index: 0 }] });
    expect(result.ok).toBe(true);
    const body = JSON.parse(lastRequest!.body);
    expect(body.view.kind).toBe('look-from');
    expect(body.focus).toEqual(['sh-1']);
    expect(body.highlight).toEqual([{ shapeId: 'sh-1', kind: 'face', index: 0 }]);
  });

  it('rejects hide together with focus without contacting the server', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const result = await screenshot({ hide: ['a'], focus: ['b'] });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
    expect(result.message).toContain('exclusive');
    expect(lastRequest).toBeNull();
  });

  it('rejects malformed annotations, empty id lists, fitTo without highlight, and a bad highlight entry', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ annotations: [{ from: [0, 0], to: [1, 1, 1] }] }, 'annotations[0].from'],
      [{ annotations: [{ from: [0, 0, 0], to: [1, 1, 1], label: 7 }] }, 'annotations[0].label'],
      [{ hide: [] }, '`hide`'],
      [{ focus: ['ok', ''] }, '`focus`'],
      [{ fitTo: 'highlight' }, 'needs a non-empty `highlight`'],
      [{ highlight: [{ shapeId: 'sh-1', kind: 'face', index: 0 }], fitTo: 'model' }, '`fitTo`'],
      [{ highlight: [{ shapeId: 'sh-1', kind: 'vertex', index: 0 }] }, '`highlight`'],
      [{ highlight: [{ expression: 'face()', scope: { part: '' } }] }, 'highlight[0].scope'],
    ];
    for (const [input, expected] of cases) {
      const result = await screenshot(input as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid-input');
        expect(result.message).toContain(expected);
      }
    }
    expect(lastRequest).toBeNull();
  });

  it('screenshot_multi posts views and applies the overlays to the whole grid', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const views = [
      { kind: 'named' as const, name: 'iso-ftr' as const },
      { kind: 'look-from' as const, eye: [100, -100, 50] as [number, number, number] },
      { kind: 'orbit-from-current' as const, azimuthDeg: 30, elevationDeg: -10 },
    ];
    const result = await screenshotMulti({ views, highlight: [{ shapeId: 'sh-1', kind: 'face', index: 4 }], fitTo: 'highlight' });
    expect(result.ok).toBe(true);
    const body = JSON.parse(lastRequest!.body);
    expect(body.multi).toBe(true);
    expect(body.views).toEqual(views);
    expect(body.view).toBeUndefined();
    expect(body.highlight).toEqual([{ shapeId: 'sh-1', kind: 'face', index: 4 }]);
    expect(body.fitTo).toBe('highlight');
  });

  it('screenshot_multi refuses fewer than 2 or more than 6 views, or an invalid one', async () => {
    fakePort = await pngServer();
    writeRegistry([entry()]);
    const iso = { kind: 'named' as const, name: 'iso-ftr' as const };
    const one = await screenshotMulti({ views: [iso] });
    expect(one.ok).toBe(false);
    if (!one.ok) {
      expect(one.code).toBe('invalid-input');
      expect(one.message).toContain('2-6');
    }
    const seven = await screenshotMulti({ views: Array(7).fill(iso) });
    expect(seven.ok).toBe(false);
    const bad = await screenshotMulti({ views: [iso, { kind: 'named', name: 'sideways' } as any] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain('views[1].name');
    }
    expect(lastRequest).toBeNull();
  });
});

describe('measure with image', () => {
  const MEASURED = {
    entities: [
      { ref: { shapeId: 'sh-1', kind: 'face', index: 5 }, geomType: 'plane', summary: { form: 'plane', center: [0, 0, 10] } },
      { ref: { shapeId: 'sh-1', kind: 'face', index: 4, instanceId: 'inst-1', pose: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } }, geomType: 'plane', summary: { form: 'plane', center: [0, 0, 0] } },
    ],
    primary: 'parallelDist',
    primaryLabel: 'Parallel distance',
    parallelDist: { value: 10.00004, from: { x: 1, y: 2, z: 0 }, to: { x: 1, y: 2, z: 10 } },
    minDist: { value: 10, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 10 } },
    unit: 'mm',
  };

  function measureServer(): Promise<number> {
    return startFakeServer({
      '/api/measure': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(MEASURED) }),
      '/api/screenshot': () => ({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
    });
  }

  it('MeasureImage builds a highlight of the measured refs, one labelled line, and a highlight fit', () => {
    const body = MeasureImage.screenshotBody(MEASURED, { width: 600, pixelRatio: 2 });
    expect(body).toEqual({
      view: { kind: 'named', name: 'iso-ftr' },
      fitTo: 'highlight',
      highlight: [
        { shapeId: 'sh-1', kind: 'face', index: 5 },
        { shapeId: 'sh-1', kind: 'face', index: 4, instanceId: 'inst-1' },
      ],
      annotations: [{ from: [1, 2, 0], to: [1, 2, 10], label: '10 mm' }],
      width: 600,
      pixelRatio: 2,
    });
  });

  it('MeasureImage labels an angle with degrees on the minimum-distance line, and draws no line for one entity', () => {
    const angle = { ...MEASURED, primary: 'angle', angleDeg: 45.004, parallelDist: undefined };
    expect(MeasureImage.annotation(angle, 2)).toEqual({ from: [0, 0, 0], to: [0, 0, 10], label: '45°' });
    expect(MeasureImage.annotation({ entities: [MEASURED.entities[0]], primary: 'totalArea', totalArea: 12 }, 1)).toBeNull();
    expect(MeasureImage.screenshotBody({ entities: [], primary: 'totalArea' }, {}).fitTo).toBeUndefined();
  });

  it('MeasureImage validates the image options', () => {
    const view = (v: unknown) => (typeof v === 'object' && v && (v as any).kind === 'named' ? v as any : '`view.kind` must be one of: named.');
    expect(MeasureImage.validate(undefined, view).ok).toBe(true);
    expect(MeasureImage.validate({ width: 0 }, view).ok).toBe(false);
    expect(MeasureImage.validate({ pixelRatio: 9 }, view).ok).toBe(false);
    const badView = MeasureImage.validate({ view: { kind: 'nope' } }, view);
    expect(badView.ok).toBe(false);
    if (!badView.ok) {
      expect(badView.message).toContain('`image.view.kind`');
    }
    expect(MeasureImage.validate({ view: { kind: 'named', name: 'top' }, width: 320, height: 240, pixelRatio: 2 }, view)).toEqual({
      ok: true,
      data: { view: { kind: 'named', name: 'top' }, width: 320, height: 240, pixelRatio: 2 },
    });
  });

  it('MeasureImage carries a section into the screenshot body and validates it', () => {
    const body = MeasureImage.screenshotBody(MEASURED, { section: { plane: 'xz', offset: -2 } });
    expect(body.section).toEqual({ plane: 'xz', offset: -2 });
    expect(body.fitTo).toBe('highlight');
    const view = (v: unknown) => v as any;
    expect(MeasureImage.validate({ section: { plane: 'xy' } }, view)).toEqual({ ok: true, data: { section: { plane: 'xy' } } });
    const bad = MeasureImage.validate({ section: { plane: 'xy', offset: 'x' } }, view);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain('`image.section.offset`');
    }
  });

  it('measure with image.section requests the screenshot in section', async () => {
    fakePort = await measureServer();
    writeRegistry([entry()]);
    const result = await measure({
      entities: [{ shapeId: 'sh-1', kind: 'face', index: 5 }, { shapeId: 'sh-1', kind: 'face', index: 4 }],
      image: { section: { plane: 'yz', offset: 1, flip: true } },
    });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/screenshot');
    const body = JSON.parse(lastRequest!.body);
    expect(body.section).toEqual({ plane: 'yz', offset: 1, flip: true });
    expect(body.view).toEqual({ kind: 'named', name: 'iso-ftr' });
    expect(body.highlight).toHaveLength(2);
  });

  it('measure without image posts once and returns the measurement alone', async () => {
    fakePort = await measureServer();
    writeRegistry([entry()]);
    const result = await measure({ entities: [{ shapeId: 'sh-1', kind: 'face', index: 5 }, { shapeId: 'sh-1', kind: 'face', index: 4 }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as any).image).toBeUndefined();
    }
    expect(lastRequest?.url).toBe('/api/measure');
  });

  it('measure with image measures, then requests the annotated screenshot, and carries the image beside the data', async () => {
    fakePort = await measureServer();
    writeRegistry([entry()]);
    const result = await measure({
      entities: [{ shapeId: 'sh-1', kind: 'face', index: 5 }, { expression: 'face().onPlane("xy", 0)' }],
      image: { view: { kind: 'named', name: 'front' }, width: 500, height: 400 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const data = result.data as any;
    expect(data.primary).toBe('parallelDist');
    expect(data.image.base64).toBe(ONE_PIXEL_PNG.toString('base64'));
    expect(lastRequest?.url).toBe('/api/screenshot');
    expect(JSON.parse(lastRequest!.body)).toEqual({
      view: { kind: 'named', name: 'front' },
      fitTo: 'highlight',
      highlight: [
        { shapeId: 'sh-1', kind: 'face', index: 5 },
        { shapeId: 'sh-1', kind: 'face', index: 4, instanceId: 'inst-1' },
      ],
      annotations: [{ from: [1, 2, 0], to: [1, 2, 10], label: '10 mm' }],
      width: 500,
      height: 400,
    });
  });

  it('measure with image reports a failed capture as the tool error, keeping the measurement in the details', async () => {
    fakePort = await startFakeServer({
      '/api/measure': () => ({ status: 200, contentType: 'application/json', body: JSON.stringify(MEASURED) }),
      '/api/screenshot': () => ({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'No UI client connected.' }) }),
    });
    writeRegistry([entry()]);
    const result = await measure({ entities: [{ shapeId: 'sh-1', kind: 'face', index: 5 }], image: {} });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect(result.message).toContain('measured, but the image failed');
    expect((result.details as any).measured.primary).toBe('parallelDist');
  });

  it('over MCP, measure with image returns the JSON text block first, then the image block', async () => {
    fakePort = await measureServer();
    writeRegistry([entry()]);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'measure',
        arguments: {
          entities: [{ shapeId: 'sh-1', kind: 'face', index: 5 }, { shapeId: 'sh-1', kind: 'face', index: 4 }],
          image: { view: { kind: 'named', name: 'iso-ftr' } },
        },
      });
      const content = (result as any).content;
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe('text');
      const parsed = JSON.parse(content[0].text);
      expect(parsed.primary).toBe('parallelDist');
      expect(parsed.image).toBeUndefined();
      expect(content[1]).toEqual({ type: 'image', data: ONE_PIXEL_PNG.toString('base64'), mimeType: 'image/png' });

      const plain = await client.callTool({ name: 'screenshot', arguments: { view: { kind: 'named', name: 'top' } } });
      expect((plain as any).content).toHaveLength(1);
      expect((plain as any).content[0].type).toBe('image');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('the measure and screenshot tool schemas expose image, the overlays and views', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const props = (name: string) => Object.keys((byName.get(name)!.inputSchema as any).properties ?? {});
      expect(props('measure')).toContain('image');
      for (const tool of ['screenshot', 'screenshot_multi', 'screenshot_shape']) {
        for (const key of ['highlight', 'hide', 'focus', 'annotations', 'fitTo', 'section']) {
          expect(props(tool)).toContain(key);
        }
      }
      expect(props('screenshot_multi')).toContain('views');
      expect(byName.get('screenshot_multi')!.description).toContain('iso-bbl');
      const imageSchema = (byName.get('measure')!.inputSchema as any).properties.image;
      expect(Object.keys(imageSchema.properties)).toContain('section');
      const sectionSchema = (byName.get('screenshot')!.inputSchema as any).properties.section;
      expect(sectionSchema.description).toContain('document units');
      expect(sectionSchema.description).toContain('normal points away from');
      expect(Object.keys(sectionSchema.properties)).toEqual(['plane', 'offset', 'flip']);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
