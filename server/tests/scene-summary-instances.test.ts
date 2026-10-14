// The scene summary's assembly half on a real kernel render, read through
// the real /api/scene/summary route: every inserted instance with its part,
// scope, grounding, the solids it shows and its statement pose — the ids
// and poses validate, interfere and resolve_selection take, checked by
// feeding them back. A part file's summary has none of these keys.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import select from '../../lib/core/select.js';
import part from '../../lib/core/part.js';
import connector from '../../lib/core/connector.js';
import assembly from '../../lib/core/assembly.js';
import insert from '../../lib/core/insert.js';
import mate from '../../lib/core/mate.js';
import replicate from '../../lib/core/replicate.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { face } from '../../lib/filters/index.js';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneSummary } from '../src/fluidcad-server/index.ts';
import { createSceneRouter } from '../src/routes/scene.ts';

const ASSEMBLY_FILE = '/ws/rig.assembly.js';
const PART_FILE = '/ws/block.part.js';

let httpServer: http.Server;
let baseUrl: string;
let engine: FluidCadServer;

function buildBlock() {
  return part('block', () => {
    sketch('xy', () => { testRect(20, 20); });
    extrude(10);
    connector('bottom', select(face().planar().onPlane('xy', 0)));
  });
}

function buildRail() {
  return part('rail', () => {
    sketch('xy', () => { testRect(100, 20); });
    extrude(10);
    connector('s1', select(face().planar().onPlane('xy', 10))).offset(-30, 0, 0);
    connector('s2', select(face().planar().onPlane('xy', 10)));
  });
}

/**
 * A grounded rail; a block mated onto it and replicated onto its second
 * seat; a block posed by hand (a quarter turn, then moved); and a pair
 * sub-assembly whose own anchor is grounded in its frame, the occurrence
 * lifted 100 above the root and grounded there.
 */
function renderRig() {
  getSceneManager().startScene();
  const block = buildBlock();
  const rail = buildRail();
  const pair = assembly('pair', () => {
    const anchor = insert(block).grounded().name('Anchor');
    const follower = insert(block).translate(30, 0, 0).name('Follower');
    return { anchor, follower };
  });
  const scene = getSceneManager().startAssemblyScene();
  const base = insert(rail).grounded().name('Rail');
  const seated = insert(block).translate(1, 2, 3).name('Seated');
  mate('fastened', seated.connectors.bottom, base.connectors.s1);
  replicate(seated, [base.connectors.s1], [[base.connectors.s2]]);
  insert(block).rotate('z', 90).translate(200, 0, 0).name('Posed');
  insert(pair).translate(0, 0, 100).grounded().name('Lifted pair');
  render();
  expect(scene.getRenderedObjects().filter((r) => r.hasError).map((r) => r.errorMessage)).toEqual([]);
  return scene;
}

async function summary(): Promise<SceneSummary> {
  const res = await fetch(`${baseUrl}/api/scene/summary`);
  expect(res.status).toBe(200);
  return await res.json() as SceneSummary;
}

describe('scene summary instances through the real route', () => {
  setupOC();

  beforeAll(async () => {
    engine = new FluidCadServer();
    engine.setSceneManager(getSceneManager() as any);
    const app = express();
    app.use('/api', createSceneRouter(engine));
    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('lists every instance with its part, scope, grounding, solids and world statement pose, and the occurrences', async () => {
    engine._setSceneForTesting(ASSEMBLY_FILE, renderRig());
    const body = await summary();

    expect(body.schemaVersion).toBe(1);
    expect(body.instancePoses).toEqual({ frame: 'world', source: 'statement' });
    const byName = new Map(body.instances!.map((i) => [i.name, i]));
    // In statement order: a sub-assembly's body runs where insert() places it.
    expect([...byName.keys()]).toEqual(['Rail', 'Seated', 'Seated (2)', 'Posed', 'Anchor', 'Follower']);

    // The part each inserts is a `part` row of objects[], by id.
    const partRows = new Map(body.objects.filter((o) => o.kind === 'part').map((o) => [o.id, o]));
    for (const instance of body.instances!) {
      expect(partRows.get(instance.partId)?.name).toBe(instance.partName);
    }
    expect(byName.get('Rail')!.partName).toBe('rail');
    expect(byName.get('Posed')!.partName).toBe('block');

    // Root instances have owner ""; the pair's are owned by its occurrence.
    const rail = byName.get('Rail')!;
    expect(rail).toMatchObject({ instanceId: 'inst-0', owner: '', grounded: true });
    expect(byName.get('Seated')).toMatchObject({ owner: '', grounded: false });
    expect(byName.get('Anchor')).toMatchObject({ instanceId: 'asm-0/inst-0', owner: 'asm-0', grounded: true });
    expect(byName.get('Follower')).toMatchObject({ instanceId: 'asm-0/inst-1', owner: 'asm-0', grounded: false });
    expect(body.occurrences).toEqual([
      { occurrenceId: 'asm-0', name: 'Lifted pair', assemblyName: 'pair', parentPath: '' },
    ]);

    // The replica names its seed and statement.
    expect(byName.get('Seated (2)')!.replica).toEqual({ of: 'inst-1', statement: 'rep-0', row: 0 });
    expect(byName.get('Seated')!.replica).toBeUndefined();

    // Every instance of one part shows the same rendered solid; the rail its own.
    const blockIds = byName.get('Seated')!.shapeIds!;
    expect(blockIds).toHaveLength(1);
    for (const name of ['Anchor', 'Follower', 'Seated (2)', 'Posed']) {
      expect(byName.get(name)!.shapeIds).toEqual(blockIds);
    }
    expect(rail.shapeIds).toHaveLength(1);
    expect(rail.shapeIds).not.toEqual(blockIds);
    const partShapes = new Set(body.objects.flatMap((o) => o.shapeIds));
    for (const id of [...blockIds, ...rail.shapeIds!]) {
      expect(partShapes.has(id)).toBe(true);
    }

    // The pose is a ready `poses` entry: the statement pose, in the world.
    // Unmated and unsolved: the seated block sits where its translate() put it.
    expect(byName.get('Seated')!.pose).toEqual({
      instanceId: 'inst-1',
      position: { x: 1, y: 2, z: 3 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    });
    const posed = byName.get('Posed')!.pose;
    expect(posed.position).toEqual({ x: 200, y: 0, z: 0 });
    expect(posed.quaternion.z).toBeCloseTo(Math.SQRT1_2, 9);
    expect(posed.quaternion.w).toBeCloseTo(Math.SQRT1_2, 9);
    // A sub-assembly's instance is composed through its occurrence frame.
    expect(byName.get('Follower')!.pose.position).toEqual({ x: 30, y: 0, z: 100 });
    expect(byName.get('Anchor')!.pose.position).toEqual({ x: 0, y: 0, z: 100 });
  });

  it('feeds validate, interfere and resolve_selection unchanged', async () => {
    engine._setSceneForTesting(ASSEMBLY_FILE, renderRig());
    const body = await summary();
    const instances = body.instances!;

    for (const instance of instances) {
      const validated = engine.validate({ instanceId: instance.instanceId });
      expect(validated.kind).toBe('report');
      if (validated.kind === 'report') {
        expect(validated.report.shapes.map((s) => s.shapeId)).toEqual(instance.shapeIds);
        expect(validated.report.ok).toBe(true);
      }
    }

    // The reported poses are what interfere already uses: passing them back changes nothing.
    const plain = engine.interfere({});
    const posed = engine.interfere({ poses: instances.map((i) => i.pose) });
    expect(plain.kind).toBe('report');
    expect(posed).toEqual(plain);
    if (plain.kind === 'report') {
      expect(plain.report.bodies).toBe(instances.reduce((n, i) => n + i.shapeIds!.length, 0));
    }
    const seated = instances.find((i) => i.name === 'Seated')!;
    expect(engine.interfere({ instanceIds: [seated.instanceId], poses: [seated.pose] }))
      .toEqual(engine.interfere({ instanceIds: [seated.instanceId] }));

    // An instance scope resolves on the instance's part, matches posed as the summary says.
    const posedBlock = instances.find((i) => i.name === 'Posed')!;
    const resolved = engine.resolveSelection({ expression: 'face()', scope: { instanceId: posedBlock.instanceId } });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.scope).toMatchObject({ kind: 'instance', instanceId: posedBlock.instanceId, partId: posedBlock.partId });
      expect(resolved.count).toBe(6);
      for (const match of resolved.matches) {
        expect(match.instanceId).toBe(posedBlock.instanceId);
        expect(posedBlock.shapeIds).toContain(match.shapeId);
        expect({ instanceId: match.instanceId, ...match.pose }).toEqual(posedBlock.pose);
      }
      // The block validate calls sound reports every face normal out of it,
      // posed: dotted with (face center − block center) it is positive.
      const centers = resolved.matches.map((m) => m.summary.center);
      const blockCenter = [0, 1, 2].map((axis) => centers.reduce((sum, c) => sum + c[axis], 0) / centers.length);
      for (const match of resolved.matches) {
        const normal = match.summary.normal!;
        const outward = normal.reduce((sum, n, axis) => sum + n * (match.summary.center[axis] - blockCenter[axis]), 0);
        expect(outward, `normal [${normal}] at [${match.summary.center}]`).toBeGreaterThan(0);
      }
    }
  });

  it('a part file carries no instance keys', async () => {
    buildBlock();
    engine._setSceneForTesting(PART_FILE, render());
    const body = await summary();
    expect(body.objects.length).toBeGreaterThan(0);
    expect('instances' in body).toBe(false);
    expect('instancePoses' in body).toBe(false);
    expect('occurrences' in body).toBe(false);
  });

  it('an assembly without sub-assemblies lists instances but no occurrences', async () => {
    getSceneManager().startScene();
    const block = buildBlock();
    const scene = getSceneManager().startAssemblyScene();
    insert(block).grounded();
    insert(block).translate(40, 0, 0);
    render();
    engine._setSceneForTesting(ASSEMBLY_FILE, scene);
    const body = await summary();
    expect(body.instances!.map((i) => [i.instanceId, i.grounded])).toEqual([['inst-0', true], ['inst-1', false]]);
    expect(body.instances![1].pose.position).toEqual({ x: 40, y: 0, z: 0 });
    expect('occurrences' in body).toBe(false);
  });
});
