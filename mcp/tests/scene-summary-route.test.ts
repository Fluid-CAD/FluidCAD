// get_scene_summary's assembly instances end to end, short of a workspace:
// the MCP tools call the real /api routes, which read a real FluidCadServer
// holding a real kernel render. Nothing between the tool and the engine is
// stubbed — a hand-written summary is how the tool descriptions came to
// promise instance ids the route never sent. Each instance's id, shapeIds
// and pose are then fed back into validate, interfere and resolve_selection
// exactly as the summary hands them over.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import select from '../../lib/core/select.js';
import part from '../../lib/core/part.js';
import connector from '../../lib/core/connector.js';
import insert from '../../lib/core/insert.js';
import mate from '../../lib/core/mate.js';
import relation from '../../lib/core/relation.js';
import { defineAssembly } from '../../lib/sdk/index.js';
import type { GeneratedAssemblyDefinition } from '../../lib/sdk/define-assembly.js';
import { CABINET_DEFAULTS, defineCabinet } from '../../lib/tests/fixtures/custom-features/cabinet.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { face } from '../../lib/filters/index.js';
import { FluidCadServer } from '../../server/src/fluidcad-server/index.ts';
import type { SceneSummary } from '../../server/src/fluidcad-server/index.ts';
import { createSceneRouter } from '../../server/src/routes/scene.ts';
import { createValidateRouter } from '../../server/src/routes/validate.ts';
import { createInterfereRouter } from '../../server/src/routes/interfere.ts';
import { createResolveSelectionRouter } from '../../server/src/routes/resolve-selection.ts';
import { buildServer } from '../src/server.ts';
import { registryFilePath } from '../src/discovery.ts';
import { getSceneSummary, interfere, resolveSelection, validate } from '../src/tools/inspection.ts';

const WORKSPACE = '/tmp/ws-scene-summary-route';

let fakeHome: string;
let homeSpy: ReturnType<typeof vi.spyOn>;
let httpServer: http.Server;
let engine: FluidCadServer;

/** A grounded plate, a block mated onto it but left at its starting pose, and a block turned and moved by hand. */
function renderRig() {
  getSceneManager().startScene();
  const plate = part('plate', () => {
    sketch('xy', () => { testRect(80, 60); });
    extrude(8);
    connector('top', select(face().planar().onPlane('xy', 8)));
  });
  const block = part('block', () => {
    sketch('xy', () => { testRect(20, 20); });
    extrude(20);
    connector('bottom', select(face().planar().onPlane('xy', 0)));
  });
  const scene = getSceneManager().startAssemblyScene();
  const base = insert(plate).grounded().name('Plate');
  const seated = insert(block).translate(10, 10, 30).name('Seated');
  insert(block).rotate('z', 30).translate(50, 20, 8).name('Posed');
  mate('fastened', base.connectors.top, seated.connectors.bottom);
  render();
  expect(scene.getRenderedObjects().filter((r) => r.hasError).map((r) => r.errorMessage)).toEqual([]);
  return scene;
}

/**
 * A grounded plate; two wheels on revolutes, one limited to [0, 270]°,
 * coupled by a reversed 2:1 gear relation; and a cabinet a generator makes
 * (doors on revolutes coupled by a gear, two drawers on sliders).
 */
function renderJointRig() {
  getSceneManager().startScene();
  const plate = part('plate', () => {
    sketch('xy', () => { testRect(80, 60); });
    extrude(8);
    connector('axleA', select(face().planar().onPlane('xy', 8)));
    connector('axleB', select(face().planar().onPlane('xy', 8))).offset(30, 0, 0);
  });
  const wheel = part('wheel', () => {
    sketch('xy', () => { testRect(20, 20); });
    extrude(4);
    connector('bore', select(face().planar().onPlane('xy', 0)));
  });
  const { Cabinet } = defineCabinet();
  const cabinet = defineAssembly(Cabinet, { label: 'Cabinet' }) as GeneratedAssemblyDefinition<any>;
  const scene = getSceneManager().startAssemblyScene();
  const base = insert(plate).grounded().name('Plate');
  const small = insert(wheel).translate(0, 0, 8).name('Small');
  const big = insert(wheel).translate(30, 0, 8).name('Big');
  const drive = mate('revolute', base.connectors.axleA, small.connectors.bore).limits(0, 270).name('Drive');
  const driven = mate('revolute', base.connectors.axleB, big.connectors.bore);
  relation('gear', drive, driven, 0.5).reverse();
  insert(cabinet).translate(200, 0, 0).grounded().name('Unit');
  render();
  expect(scene.getRenderedObjects().filter((r) => r.hasError).map((r) => r.errorMessage)).toEqual([]);
  return scene;
}

async function startEngine(fileName: string, scene: unknown): Promise<void> {
  engine = new FluidCadServer();
  engine.setSceneManager(getSceneManager() as any);
  engine._setSceneForTesting(fileName, scene);

  const app = express();
  app.use(express.json());
  app.use('/api', createSceneRouter(engine));
  app.use('/api', createValidateRouter(engine));
  app.use('/api', createInterfereRouter(engine));
  app.use('/api', createResolveSelectionRouter(engine));
  httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as { port: number }).port;

  fs.mkdirSync(path.dirname(registryFilePath()), { recursive: true });
  fs.writeFileSync(registryFilePath(), JSON.stringify({
    schemaVersion: 1,
    instances: [{ workspacePath: WORKSPACE, port, pid: process.pid, version: '0.0.46', startedAt: 'x' }],
  }));
}

async function summaryOf(): Promise<SceneSummary> {
  const result = await getSceneSummary({});
  expect(result.ok).toBe(true);
  return (result as { ok: true; data: SceneSummary }).data;
}

describe('get_scene_summary instances through the real routes', () => {
  setupOC();

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-summary-route-'));
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    homeSpy.mockRestore();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('lists the instances, and their ids, shapeIds and poses feed validate, interfere and resolve_selection', async () => {
    await startEngine('/ws/rig.assembly.js', renderRig());

    const summary = await summaryOf();
    expect(summary.instancePoses).toEqual({ frame: 'world', source: 'statement' });
    expect(summary.occurrences).toBeUndefined();
    const byName = new Map(summary.instances!.map((i) => [i.name, i]));
    expect([...byName.keys()]).toEqual(['Plate', 'Seated', 'Posed']);
    expect(byName.get('Plate')).toMatchObject({ instanceId: 'inst-0', partName: 'plate', owner: '', grounded: true });
    expect(byName.get('Seated')).toMatchObject({ instanceId: 'inst-1', partName: 'block', owner: '', grounded: false });
    // Mated, but the server never solves: the seated block reports its starting pose.
    expect(byName.get('Seated')!.pose).toEqual({
      instanceId: 'inst-1', position: { x: 10, y: 10, z: 30 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
    });
    expect(byName.get('Posed')!.shapeIds).toEqual(byName.get('Seated')!.shapeIds);
    expect(byName.get('Plate')!.shapeIds).toHaveLength(1);

    for (const instance of summary.instances!) {
      const checked = await validate({ instanceId: instance.instanceId });
      expect(checked.ok).toBe(true);
      expect((checked as any).data.shapes.map((s: any) => s.shapeId)).toEqual(instance.shapeIds);
    }

    const poses = summary.instances!.map((i) => i.pose);
    const plain = await interfere({});
    const posed = await interfere({ poses });
    expect(plain.ok && posed.ok).toBe(true);
    expect((posed as any).data).toEqual((plain as any).data);
    // Starting poses put the seated block 22 above the plate: clear, and so the
    // check says, not inconclusive.
    expect((plain as any).data).toMatchObject({ ok: true, units: 3 });

    const posedBlock = byName.get('Posed')!;
    const resolved = await resolveSelection({ expression: 'face()', scope: { instanceId: posedBlock.instanceId } });
    expect(resolved.ok).toBe(true);
    const data = (resolved as any).data;
    expect(data.count).toBe(6);
    for (const match of data.matches) {
      expect(posedBlock.shapeIds).toContain(match.shapeId);
      expect({ instanceId: match.instanceId, ...match.pose }).toEqual(posedBlock.pose);
    }
  });

  it('over MCP: the summary carries the instances, and interfere takes their poses as they are', async () => {
    await startEngine('/ws/rig.assembly.js', renderRig());
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.callTool({ name: 'get_scene_summary', arguments: { workspace: WORKSPACE } });
      expect(listed.isError).not.toBe(true);
      const summary = JSON.parse((listed.content as any[])[0].text) as SceneSummary;
      expect(summary.instances!.map((i) => i.instanceId)).toEqual(['inst-0', 'inst-1', 'inst-2']);

      const plain = await client.callTool({ name: 'interfere', arguments: { workspace: WORKSPACE } });
      const posed = await client.callTool({
        name: 'interfere',
        arguments: { workspace: WORKSPACE, poses: summary.instances!.map((i) => i.pose) },
      });
      expect(posed.isError).not.toBe(true);
      expect(JSON.parse((posed.content as any[])[0].text)).toEqual(JSON.parse((plain.content as any[])[0].text));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('over MCP: the summary lists the mates and relations, a generator\'s engine-owned in its occurrence', async () => {
    await startEngine('/ws/drive.assembly.js', renderJointRig());
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.callTool({ name: 'get_scene_summary', arguments: { workspace: WORKSPACE } });
      expect(listed.isError).not.toBe(true);
      const summary = JSON.parse((listed.content as any[])[0].text) as SceneSummary;

      expect(summary.joints).toEqual({ source: 'statement', solvedIn: 'viewer' });
      expect(summary.mates!.map((m) => [m.mateId, m.type, m.name ?? null, m.ownerName ?? null, m.engineOwned ?? false, m.options ?? null])).toEqual([
        ['mate-0', 'revolute', 'Drive', null, false, { limits: [0, 270] }],
        ['mate-1', 'revolute', null, null, false, null],
        ['asm-0/mate-0', 'revolute', 'Left door', 'Unit', true, { limits: [0, CABINET_DEFAULTS.hingeAngle] }],
        ['asm-0/mate-1', 'revolute', 'Right door', 'Unit', true, { limits: [-CABINET_DEFAULTS.hingeAngle, 0] }],
        ['asm-0/mate-2', 'slider', 'Drawer 1', 'Unit', true, { limits: [0, 448] }],
        ['asm-0/mate-3', 'slider', 'Drawer 2', 'Unit', true, { limits: [0, 448] }],
      ]);
      const [drive] = summary.mates!;
      expect(drive.a).toMatchObject({ kind: 'connector', instanceId: 'inst-0', instance: 'Plate', connector: 'axleA' });
      expect(drive.b).toMatchObject({ kind: 'connector', instanceId: 'inst-1', instance: 'Small', connector: 'bore' });
      expect(summary.mates!.every((m) => !('status' in m))).toBe(true);
      expect(summary.relations!.map((r) => [r.relationId, r.type, r.ratio, r.reverse, r.mateA, r.mateB, r.engineOwned ?? false])).toEqual([
        ['rel-0', 'gear', 0.5, true, { mateId: 'mate-0', name: 'Drive' }, { mateId: 'mate-1' }, false],
        ['asm-0/rel-0', 'gear', 1, true, { mateId: 'asm-0/mate-0', name: 'Left door' }, { mateId: 'asm-0/mate-1', name: 'Right door' }, true],
      ]);

      // The sides' instance ids are the ones the inspection tools take.
      const doorSide = summary.mates![2].b;
      expect(doorSide.kind).toBe('connector');
      const checked = await client.callTool({
        name: 'validate',
        arguments: { workspace: WORKSPACE, instanceId: (doorSide as { instanceId: string }).instanceId },
      });
      expect(checked.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a part file\'s summary has no instance keys', async () => {
    part('block', () => {
      sketch('xy', () => { testRect(20, 20); });
      extrude(20);
    });
    await startEngine('/ws/block.part.js', render());
    const summary = await summaryOf();
    expect(summary.objects.length).toBeGreaterThan(0);
    expect(Object.keys(summary)).not.toContain('instances');
    expect(Object.keys(summary)).not.toContain('instancePoses');
    expect(Object.keys(summary)).not.toContain('occurrences');
    expect(Object.keys(summary)).not.toContain('joints');
    expect(Object.keys(summary)).not.toContain('mates');
    expect(Object.keys(summary)).not.toContain('relations');
  });
});
