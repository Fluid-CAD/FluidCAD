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
  getCompileError,
  getEdgeProperties,
  getFaceProperties,
  getSceneSummary,
  getShapeProperties,
  hitTest,
  listShapes,
  measure,
  resolveClient,
  resolveSelection,
  validate,
  interfere,
} from '../src/tools/inspection.ts';
import type { RegistryEntry } from '../src/types.ts';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let fakeServer: http.Server | null = null;
let fakePort: number = 0;
let lastRequest: { method: string; url: string; body: string } | null = null;

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    workspacePath: '/tmp/ws-mcp-inspect',
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

/** Stand-in for FluidCadServer that records each request and answers with
 *  a canned payload — keeps these tests free of OCC dependencies. */
function startFakeServer(routes: Record<string, (req: http.IncomingMessage, body: string) => { status: number; body: any } | null>): Promise<number> {
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
          res.end(JSON.stringify({ ok: true, version: '0.0.33', workspacePath: '/tmp/ws-mcp-inspect', startedAt: 'x', pid: process.pid }));
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
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
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
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-mcp-inspect-test-'));
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

describe('resolveClient', () => {
  it('returns no-server when no instances are running', () => {
    const result = resolveClient({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('no-server');
  });

  it('returns workspace-not-found when the requested workspace is missing', async () => {
    fakePort = await startFakeServer({});
    writeRegistry([entry()]);
    const result = resolveClient({ workspace: '/tmp/nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('workspace-not-found');
  });

  it('returns no-workspace when multiple instances are running and none specified', async () => {
    fakePort = await startFakeServer({});
    writeRegistry([
      entry({ workspacePath: '/tmp/ws-a' }),
      entry({ workspacePath: '/tmp/ws-b', port: fakePort + 1 }),
    ]);
    const result = resolveClient({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('no-workspace');
  });

  it('uses the singleton when only one instance is running', async () => {
    fakePort = await startFakeServer({});
    writeRegistry([entry()]);
    const result = resolveClient({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.entry.workspacePath).toBe('/tmp/ws-mcp-inspect');
    await result.data.client.close();
  });
});

describe('inspection tools (unit)', () => {
  beforeEach(async () => {
    fakePort = await startFakeServer({
      '/api/scene/summary': () => ({
        status: 200,
        body: {
          schemaVersion: 1,
          file: '/tmp/ws-mcp-inspect/part.fluid.js',
          unit: 'in',
          objects: [
            { index: 0, id: 'obj-12', kind: 'sketch', name: 'outer', params: { plane: 'xy' }, shapeIds: ['sh-1'], fromCache: false, hasError: false, containerId: null },
            { index: 1, id: 'obj-13', kind: 'extrude', name: 'Extrude', params: { distance: 30 }, shapeIds: ['sh-2'], fromCache: false, hasError: false, containerId: null },
          ],
          rollbackStop: 1,
          compileError: null,
        },
      }),
      '/api/scene/shapes': () => ({
        status: 200,
        body: {
          shapes: [
            { shapeId: 'sh-1', type: 'Sketch', sceneObjectId: 'obj-12' },
            { shapeId: 'sh-2', type: 'Solid', sceneObjectId: 'obj-13' },
          ],
        },
      }),
      '/api/scene/compile-error': () => ({
        status: 200,
        body: { compileError: null },
      }),
      '/api/shape-properties': () => ({ status: 200, body: { volumeMm3: 150000, unit: 'in' } }),
      '/api/face-properties': () => ({ status: 200, body: { areaMm2: 5000, unit: 'in' } }),
      '/api/edge-properties': () => ({ status: 200, body: { length: 100, unit: 'in' } }),
      '/api/hit-test': () => ({ status: 200, body: { type: 'face', index: 3 } }),
      '/api/measure': (_req, body) => {
        const entities = JSON.parse(body).entities as any[];
        if (entities.some((e) => typeof e.expression === 'string' && e.expression.includes('parallelTo'))) {
          return {
            status: 409,
            body: {
              error: 'entities[0]: face().parallelTo("yz") matches 2 entities in part "base"; narrow the filter to one (candidates listed)',
              code: 'ambiguous-match',
              candidates: [{ shapeId: 'sh-2', kind: 'face', index: 0 }, { shapeId: 'sh-2', kind: 'face', index: 1 }],
            },
          };
        }
        return { status: 200, body: { primary: 'totalArea', totalArea: 12.5, unit: 'in' } };
      },
      '/api/resolve-selection': (_req, body) => {
        const request = JSON.parse(body);
        if (request.scope?.part === 'nope') {
          return { status: 404, body: { error: 'No part "nope" in the scene', code: 'unknown-scope' } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            matches: [{
              shapeId: 'sh-2', kind: 'face', index: 5, sceneObjectId: 'obj-13', sceneObjectName: 'extrude', part: 'base',
              summary: { form: 'plane', center: [20, 20, 10], normal: [0, 0, 1], area: 1600 },
            }],
            count: 1,
            scope: request.scope ? { kind: 'part', partId: 'obj-1', part: 'base' } : { kind: 'root' },
            ...(request.before !== undefined ? { before: request.before } : {}),
            unit: 'in',
            synthesized: {
              ok: true, expression: '$obj["obj-13"].endFaces()', source: 'e.endFaces()', sameAsInput: false,
              parts: [{ producer: 'obj-13', accessor: 'endFaces', tier: 0 }],
              producers: [{ sceneObjectId: 'obj-13', sceneObjectName: 'extrude', featureType: 'extrude', variable: 'e', filePath: '/ws/m.fluid.js', line: 4, column: 0, bound: true }],
              imports: [], alternatives: [],
            },
          },
        };
      },
      '/api/validate': (_req, body) => {
        const request = body ? JSON.parse(body) : {};
        if (request.instanceId === 'nope') {
          return { status: 404, body: { error: 'No instance "nope" in the assembly (instance ids come from get_scene_summary).', code: 'unknown-instance' } };
        }
        const broken = !request.shapeIds || request.shapeIds.includes('sh-3');
        return {
          status: 200,
          body: {
            ok: !broken,
            checked: broken ? 2 : 1,
            findings: broken
              ? [{ kind: 'nonPositiveVolume', shapeId: 'sh-3', sceneObjectId: 'obj-14', part: 'pillar', message: 'the solid has volume -3000: reversed orientation (inside-out); BRepCheck_Analyzer does not catch this' }]
              : [],
            shapes: [{ shapeId: 'sh-2', sceneObjectId: 'obj-13', sceneObjectName: 'extrude', part: 'base', faces: 6, edges: 12, solids: 1, volume: 16000, findings: [] }],
            skipped: [],
            checks: ['invalidTopology', 'openShell', 'nonPositiveVolume', 'noSolid'],
            notChecked: { selfIntersecting: 'not checked: this ocjs build exposes neither BRepAlgoAPI_Check nor BOPAlgo_ArgumentAnalyzer' },
            unit: 'in',
          },
        };
      },
      '/api/interfere': (_req, body) => {
        const request = body ? JSON.parse(body) : {};
        if (request.instanceIds?.includes('nope')) {
          return { status: 404, body: { error: 'No instance "nope" in the assembly (instance ids come from get_scene_summary).', code: 'unknown-instance' } };
        }
        const bodyA = { shapeId: 'sh-2', sceneObjectId: 'obj-13', sceneObjectName: 'extrude', part: 'box', instanceId: 'inst-1' };
        const bodyB = { ...bodyA, instanceId: 'inst-2' };
        if (request.shapeIds?.length === 1) {
          return {
            status: 200,
            body: { ok: false, inconclusive: 'only one rendered solid; interference needs at least two bodies', bodies: 1, units: 1, checked: 0, rejectedByBounds: 0, clashes: [], intraPart: [], failed: [], tolerance: 0.000061, unit: 'in' },
          };
        }
        const clear = request.poses !== undefined || (request.tolerance ?? 0) > 5;
        return {
          status: 200,
          body: {
            ok: clear, bodies: 2, units: 2, checked: 1, rejectedByBounds: 0,
            clashes: clear ? [] : [{ a: bodyA, b: bodyB, volume: 4.88 }],
            intraPart: [], failed: [], tolerance: request.tolerance ?? 0.000061, unit: 'in',
          },
        };
      },
    });
    writeRegistry([entry()]);
  });

  it('interfere posts an empty body for the whole scene and returns the report', async () => {
    const result = await interfere({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/interfere');
    expect(JSON.parse(lastRequest!.body)).toEqual({});
    const data = result.data as any;
    expect(data.ok).toBe(false);
    expect(data.checked).toBe(1);
    expect(data.clashes[0]).toMatchObject({ a: { instanceId: 'inst-1' }, b: { instanceId: 'inst-2' }, volume: 4.88 });
    expect(data.unit).toBe('in');
  });

  it('interfere forwards instanceIds, shapeIds, tolerance and poses and omits the keys it was not given', async () => {
    const scoped = await interfere({ shapeIds: ['sh-2'] });
    expect(scoped.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ shapeIds: ['sh-2'] });
    expect((scoped.ok && (scoped.data as any).inconclusive)).toContain('only one');

    const pose = { instanceId: 'inst-2', position: { x: 40, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
    const posed = await interfere({ instanceIds: ['inst-1', 'inst-2'], tolerance: 0, poses: [pose] });
    expect(posed.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ instanceIds: ['inst-1', 'inst-2'], tolerance: 0, poses: [pose] });
    expect((posed.ok && (posed.data as any).ok)).toBe(true);
  });

  it('interfere rejects empty id lists, a negative tolerance and a malformed pose before calling the server', async () => {
    lastRequest = null;
    const empty = await interfere({ instanceIds: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('invalid-input');
      expect(empty.message).toContain('instanceIds');
    }
    const blankShape = await interfere({ shapeIds: ['sh-2', ''] });
    expect(blankShape.ok).toBe(false);
    const negative = await interfere({ tolerance: -1 });
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.message).toContain('tolerance');
    }
    const badPose = await interfere({ poses: [{ instanceId: 'inst-1', position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 0 } }] });
    expect(badPose.ok).toBe(false);
    if (!badPose.ok) {
      expect(badPose.message).toContain('quaternion');
    }
    const noInstance = await interfere({ poses: [{ position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } as any] });
    expect(noInstance.ok).toBe(false);
    expect(lastRequest).toBeNull();
  });

  it('interfere surfaces an unknown instance as the server\'s 404 with its code', async () => {
    const result = await interfere({ instanceIds: ['nope'] });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect(result.message).toContain('unknown-instance');
    expect((result.details as any).statusCode).toBe(404);
  });

  it('validate posts an empty body for the whole scene and returns the report', async () => {
    const result = await validate({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/validate');
    expect(JSON.parse(lastRequest!.body)).toEqual({});
    const data = result.data as any;
    expect(data.ok).toBe(false);
    expect(data.checked).toBe(2);
    expect(data.findings[0]).toMatchObject({ kind: 'nonPositiveVolume', shapeId: 'sh-3', part: 'pillar' });
    expect(data.checks).toContain('openShell');
    expect(data.notChecked.selfIntersecting).toContain('not checked');
    expect(data.unit).toBe('in');
  });

  it('validate forwards shapeIds and instanceId and omits the keys it was not given', async () => {
    const scoped = await validate({ shapeIds: ['sh-2'] });
    expect(scoped.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ shapeIds: ['sh-2'] });
    expect((scoped.ok && (scoped.data as any).ok)).toBe(true);

    await validate({ instanceId: 'inst-1' });
    expect(JSON.parse(lastRequest!.body)).toEqual({ instanceId: 'inst-1' });
  });

  it('validate rejects an empty shapeIds list and a blank instanceId before calling the server', async () => {
    lastRequest = null;
    const empty = await validate({ shapeIds: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('invalid-input');
      expect(empty.message).toContain('shapeIds');
    }
    const blankEntry = await validate({ shapeIds: ['sh-2', ''] });
    expect(blankEntry.ok).toBe(false);
    const blankInstance = await validate({ instanceId: '' });
    expect(blankInstance.ok).toBe(false);
    if (!blankInstance.ok) {
      expect(blankInstance.message).toContain('instanceId');
    }
    expect(lastRequest).toBeNull();
  });

  it('validate surfaces an unknown instance as the server\'s 404 with its code', async () => {
    const result = await validate({ instanceId: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect(result.message).toContain('unknown-instance');
    expect((result.details as any).statusCode).toBe(404);
  });

  it('resolve_selection posts the expression and scope and returns the matches', async () => {
    const result = await resolveSelection({ expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/resolve-selection');
    expect(JSON.parse(lastRequest!.body)).toEqual({ expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } });
    const data = result.data as any;
    expect(data.count).toBe(1);
    expect(data.matches[0].summary.form).toBe('plane');
    expect(data.scope).toEqual({ kind: 'part', partId: 'obj-1', part: 'base' });
    expect(data.unit).toBe('in');
  });

  it('resolve_selection posts picks and the boundary, and returns the synthesized selector', async () => {
    const result = await resolveSelection({ picks: [{ shapeId: 'sh-2', kind: 'face', index: 5 }], before: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(lastRequest!.body)).toEqual({ picks: [{ shapeId: 'sh-2', kind: 'face', index: 5 }], before: 7 });
    const data = result.data as any;
    expect(data.before).toBe(7);
    expect(data.synthesized.source).toBe('e.endFaces()');
    expect(data.synthesized.producers[0].bound).toBe(true);
  });

  it('resolve_selection rejects both or neither input, malformed picks and a bad boundary before calling the server', async () => {
    lastRequest = null;
    const neither = await resolveSelection({});
    expect(neither.ok).toBe(false);
    if (!neither.ok) {
      expect(neither.message).toContain('exactly one of');
    }
    const both = await resolveSelection({ expression: 'face()', picks: [{ shapeId: 'sh-2', kind: 'face', index: 5 }] });
    expect(both.ok).toBe(false);
    const badPick = await resolveSelection({ picks: [{ shapeId: 'sh-2', kind: 'face', index: -1 }] });
    expect(badPick.ok).toBe(false);
    if (!badPick.ok) {
      expect(badPick.message).toContain('picks[0]');
    }
    const badBefore = await resolveSelection({ expression: 'face()', before: 0 });
    expect(badBefore.ok).toBe(false);
    if (!badBefore.ok) {
      expect(badBefore.message).toContain('before');
    }
    expect(lastRequest).toBeNull();
  });

  it('resolve_selection omits the scope key when none is given', async () => {
    const result = await resolveSelection({ expression: 'edge().circle(5)' });
    expect(result.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ expression: 'edge().circle(5)' });
  });

  it('resolve_selection rejects an empty expression and a malformed scope before calling the server', async () => {
    lastRequest = null;
    const empty = await resolveSelection({ expression: '  ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('invalid-input');
    }
    const twoKeys = await resolveSelection({ expression: 'face()', scope: { part: 'a', instanceId: 'b' } as any });
    expect(twoKeys.ok).toBe(false);
    if (!twoKeys.ok) {
      expect(twoKeys.code).toBe('invalid-input');
      expect(twoKeys.message).toContain('exactly one of');
    }
    const emptyId = await resolveSelection({ expression: 'face()', scope: { sceneObjectId: '' } });
    expect(emptyId.ok).toBe(false);
    expect(lastRequest).toBeNull();
  });

  it('resolve_selection surfaces an unknown scope as the server\'s 4xx', async () => {
    const result = await resolveSelection({ expression: 'face()', scope: { part: 'nope' } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect(result.message).toContain('nope');
    expect(result.message).toContain('unknown-scope');
    expect((result.details as any).statusCode).toBe(404);
  });

  it('measure forwards filter entities beside index entities', async () => {
    const entities = [
      { expression: 'face().onPlane("xy", 10)', scope: { part: 'base' } },
      { shapeId: 'sh-2', kind: 'edge' as const, index: 3 },
    ];
    const result = await measure({ entities });
    expect(result.ok).toBe(true);
    expect(JSON.parse(lastRequest!.body)).toEqual({ entities });
  });

  it('measure refuses a filter that matches several entities with the candidates, never taking the first', async () => {
    const result = await measure({ entities: [{ expression: 'face().parallelTo("yz")', scope: { part: 'base' } }] });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('http-error');
    expect((result.details as any).statusCode).toBe(409);
    expect(result.message).toContain('matches 2 entities');
  });

  it('measure validates filter entities locally', async () => {
    lastRequest = null;
    const empty = await measure({ entities: [{ expression: '' }] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('invalid-input');
      expect(empty.message).toContain('entities[0].expression');
    }
    const badScope = await measure({ entities: [{ expression: 'face()', scope: { part: '' } }] });
    expect(badScope.ok).toBe(false);
    expect(lastRequest).toBeNull();
  });

  it('get_scene_summary resolves the workspace and returns the payload', async () => {
    const result = await getSceneSummary({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.data as any).schemaVersion).toBe(1);
    expect((result.data as any).objects.length).toBe(2);
    // The document unit rides along verbatim — the agent labels lengths with it.
    expect((result.data as any).unit).toBe('in');
  });

  it('property and measure payloads pass the document unit through untouched', async () => {
    const shape = await getShapeProperties({ shapeId: 'sh-2' });
    expect(shape.ok && (shape.data as any).unit).toBe('in');
    const face = await getFaceProperties({ shapeId: 'sh-2', faceIndex: 0 });
    expect(face.ok && (face.data as any).unit).toBe('in');
    const edge = await getEdgeProperties({ shapeId: 'sh-2', edgeIndex: 0 });
    expect(edge.ok && (edge.data as any).unit).toBe('in');
    const measured = await measure({ entities: [{ shapeId: 'sh-2', kind: 'face', index: 0 }] });
    expect(measured.ok && (measured.data as any).unit).toBe('in');
    expect(lastRequest?.url).toBe('/api/measure');
  });

  it('list_shapes returns the flat shape list', async () => {
    const result = await listShapes({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.data as any).shapes).toHaveLength(2);
  });

  it('get_compile_error returns null when there is none', async () => {
    const result = await getCompileError({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect((result.data as any).compileError).toBeNull();
  });

  it('get_shape_properties forwards shapeId in the query string', async () => {
    const result = await getShapeProperties({ shapeId: 'sh-1' });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/shape-properties?shapeId=sh-1');
  });

  it('get_shape_properties rejects empty shapeId', async () => {
    const result = await getShapeProperties({ shapeId: '' as string });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_face_properties forwards shapeId and faceIndex', async () => {
    const result = await getFaceProperties({ shapeId: 'sh-2', faceIndex: 4 });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/face-properties?shapeId=sh-2&faceIndex=4');
  });

  it('get_face_properties rejects negative faceIndex', async () => {
    const result = await getFaceProperties({ shapeId: 'sh-2', faceIndex: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });

  it('get_edge_properties forwards shapeId and edgeIndex', async () => {
    const result = await getEdgeProperties({ shapeId: 'sh-2', edgeIndex: 7 });
    expect(result.ok).toBe(true);
    expect(lastRequest?.url).toBe('/api/edge-properties?shapeId=sh-2&edgeIndex=7');
  });

  it('hit_test posts ray data and defaults edgeThreshold to 0', async () => {
    const result = await hitTest({
      shapeId: 'sh-2',
      rayOrigin: [0, 0, 100],
      rayDir: [0, 0, -1],
    });
    expect(result.ok).toBe(true);
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/hit-test');
    const body = JSON.parse(lastRequest!.body);
    expect(body.shapeId).toBe('sh-2');
    expect(body.rayOrigin).toEqual([0, 0, 100]);
    expect(body.edgeThreshold).toBe(0);
  });

  it('hit_test rejects non-numeric ray vectors', async () => {
    const result = await hitTest({
      shapeId: 'sh-2',
      rayOrigin: ['a', 0, 0] as any,
      rayDir: [0, 0, -1],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('invalid-input');
  });
});

describe('inspection tools (over MCP)', () => {
  it('the MCP client sees all seven inspection tools', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      for (const expected of [
        'get_scene_summary',
        'list_shapes',
        'get_compile_error',
        'get_shape_properties',
        'get_face_properties',
        'get_edge_properties',
        'hit_test',
        'resolve_selection',
        'validate',
        'interfere',
      ]) {
        expect(names.has(expected)).toBe(true);
      }
      // interfere must tell the agent what a clash and an intraPart entry
      // are, that inconclusive is not a pass, what tolerance means, and
      // which poses the bodies sit at.
      const interfereTool = tools.tools.find((t) => t.name === 'interfere')!;
      expect(interfereTool.description).toContain('`clash`');
      expect(interfereTool.description).toContain('`intraPart`');
      expect(interfereTool.description).toContain('never fail');
      expect(interfereTool.description).toContain('NOT a pass');
      expect(interfereTool.description).toContain('`tolerance`');
      expect(interfereTool.description).toContain('document unit cubed');
      expect(interfereTool.description).toContain('STATEMENT poses');
      expect(interfereTool.description).toContain('`poses`');
      const interfereSchema = JSON.stringify(interfereTool.inputSchema);
      for (const field of ['instanceIds', 'shapeIds', 'tolerance', 'poses']) {
        expect(interfereSchema).toContain(`"${field}"`);
      }
      // validate must tell the agent what a render does not prove, what each
      // finding means, that inversion is caught by the volume sign alone, and
      // that self-intersection is not checked in this build.
      const validateTool = tools.tools.find((t) => t.name === 'validate')!;
      expect(validateTool.description).toContain('not a geometry claim');
      for (const kind of ['invalidTopology', 'openShell', 'nonPositiveVolume', 'noSolid']) {
        expect(validateTool.description).toContain(`\`${kind}\``);
      }
      expect(validateTool.description).toContain('volume sign ONLY');
      expect(validateTool.description).toContain('Self-intersection is NOT checked');
      expect(validateTool.description).not.toContain('selfIntersection:');
      expect(JSON.stringify(validateTool.inputSchema)).not.toContain('selfIntersection');
      // The descriptions must not promise mm: lengths are in the document unit.
      const byName = new Map(tools.tools.map((t) => [t.name, t.description ?? '']));
      expect(byName.get('measure')).toContain('document unit');
      expect(byName.get('measure')).not.toContain('All lengths are mm');
      // The agent must learn the scoping rule and the $obj binding from the
      // tool surface alone, and that a filter entity must resolve to one.
      const resolve = tools.tools.find((t) => t.name === 'resolve_selection')!;
      expect(resolve.description).toContain('select()');
      expect(resolve.description).toContain('count 0');
      const resolveSchema = JSON.stringify(resolve.inputSchema);
      expect(resolveSchema).toContain('$obj');
      expect(resolveSchema).toContain('never matches faces of part');
      expect(resolveSchema).toContain('instanceId');
      expect(byName.get('measure')).toContain('exactly one face/edge');
      expect(byName.get('measure')).toContain('`summary`');
      for (const name of ['get_scene_summary', 'get_shape_properties', 'get_face_properties', 'get_edge_properties']) {
        expect(byName.get(name)).toContain('`unit`');
      }
      expect(byName.get('pack_model')).toContain('`unit`');
      expect(byName.get('pack_model')).toContain('schemaVersion 3');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('get_scene_summary resolves through FluidCadClient and returns a parseable payload', async () => {
    fakePort = await startFakeServer({
      '/api/scene/summary': () => ({
        status: 200,
        body: {
          schemaVersion: 1,
          file: '/tmp/ws-mcp-inspect/part.fluid.js',
          unit: 'in',
          objects: [],
          rollbackStop: -1,
          compileError: null,
        },
      }),
    });
    writeRegistry([entry()]);

    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'get_scene_summary',
        arguments: { workspace: '/tmp/ws-mcp-inspect' },
      });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(payload.schemaVersion).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('get_scene_summary surfaces workspace-not-found as a tool error', async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'get_scene_summary',
        arguments: { workspace: '/tmp/does-not-exist' },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse((result.content as any[])[0].text);
      expect(['workspace-not-found', 'no-server']).toContain(payload.code);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
