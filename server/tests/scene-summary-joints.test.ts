// The scene summary's joints on a real kernel render, read through the real
// /api/scene/summary route: every mate with its type, authored name, owning
// scope, engine-owned flag, both sides named (instance and connector, an
// assembly connector, a tangent mate's exposures) and its options; every
// relation with the two mates it couples. A generated assembly's joints
// (a cabinet: doors on limited revolutes coupled by a gear, a drawer on a
// slider) live in its occurrence's scope and are engine-owned; a root mate
// onto one of its parts is not. No entry carries a solve status: the server
// never solves. A part file's summary has none of these keys.

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
import expose from '../../lib/core/expose.js';
import insert from '../../lib/core/insert.js';
import mate from '../../lib/core/mate.js';
import relation from '../../lib/core/relation.js';
import { defineAssembly } from '../../lib/sdk/index.js';
import type { GeneratedAssemblyDefinition } from '../../lib/sdk/define-assembly.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { face } from '../../lib/filters/index.js';
import { CABINET_DEFAULTS, defineCabinet, drawerTravel } from '../../lib/tests/fixtures/custom-features/cabinet.js';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import type { SceneSummary, SceneSummaryMate } from '../src/fluidcad-server/index.ts';
import { createSceneRouter } from '../src/routes/scene.ts';

const ASSEMBLY_FILE = '/ws/rig.assembly.js';
const CABINET_FILE = '/ws/assemblies/cabinet.assembly.js';
const PART_FILE = '/ws/block.part.js';

let httpServer: http.Server;
let baseUrl: string;
let engine: FluidCadServer;

/** The cabinet generator, defined as its own file defines it: the definition located in `CABINET_FILE`. */
function cabinetDef(): GeneratedAssemblyDefinition<any> {
  const { Cabinet } = defineCabinet();
  return new Function('defineAssembly', 'Cabinet', `return defineAssembly(Cabinet, { label: 'Cabinet' });\n//# sourceURL=${CABINET_FILE}`)(
    defineAssembly, Cabinet,
  ) as GeneratedAssemblyDefinition<any>;
}

/**
 * A plate fastened to an assembly connector; a lever on a revolute limited
 * to [-30, 90]° (named "Pivot"); a carriage on a flipped slider offset 5
 * along its axis; a puck tangent to the plate's deck, not propagated; a
 * rack-and-pinion relation of the pivot and the slider (62.8 per turn,
 * reversed, named "Drive"); a cabinet generated with one drawer
 * ("Kitchen"); and a root mate of the plate onto the cabinet's carcass.
 */
function renderRig() {
  getSceneManager().startScene();
  const base = part('base', () => {
    sketch('xy', () => { testRect(100, 60); });
    extrude(10);
    connector('pivot', select(face().planar().onPlane('xy', 10)));
    connector('rail', select(face().planar().onPlane('xy', 10))).offset(30, 0, 0);
    connector('foot', select(face().planar().onPlane('xy', 0)));
    expose('deck', select(face().planar().onPlane('xy', 10)));
  });
  const arm = part('arm', () => {
    sketch('xy', () => { testRect(40, 10); });
    extrude(5);
    connector('bore', select(face().planar().onPlane('xy', 0)));
  });
  const block = part('block', () => {
    sketch('xy', () => { testRect(20, 20); });
    extrude(10);
    connector('shoe', select(face().planar().onPlane('xy', 0)));
    expose('skin', select(face().planar().onPlane('xy', 0)));
  });
  const cabinet = cabinetDef();
  const scene = getSceneManager().startAssemblyScene();
  const scope: Record<string, unknown> = { connector, insert, mate, relation, base, arm, block, cabinet };
  const names = Object.keys(scope);
  new Function(...names, `${RIG.join('\n')}\n//# sourceURL=${ASSEMBLY_FILE}`)(...names.map((name) => scope[name]));
  render();
  expect(scene.getRenderedObjects().filter((r) => r.hasError).map((r) => r.errorMessage)).toEqual([]);
  return scene;
}

/** The rig's assembly statements, one per line. */
const RIG = [
  "const datum = connector('datum', [0, 0, 0]);",
  "const plate = insert(base).name('Plate');",
  "const lever = insert(arm).translate(0, 0, 20).name('Lever');",
  "const carriage = insert(block).translate(30, 0, 20).name('Carriage');",
  "const puck = insert(block).translate(-30, 0, 20).name('Puck');",
  "mate('fastened', datum, plate.connectors.foot);",
  "const pivot = mate('revolute', plate.connectors.pivot, lever.connectors.bore).limits(-30, 90).name('Pivot');",
  "const slide = mate('slider', plate.connectors.rail, carriage.connectors.shoe).flip().offset(0, 0, 5);",
  "mate('tangent', puck.features.skin, plate.features.deck).noPropagate();",
  "relation('rack-and-pinion', pivot, slide, 62.8).reverse().name('Drive');",
  "const kitchen = insert(cabinet, { drawers: 1 }).translate(300, 0, 0).grounded().name('Kitchen');",
  "mate('fastened', plate.connectors.foot, kitchen.parts.carcass.connectors.base).name('Kitchen on plate');",
];

/** The line a `RIG` statement stands on in the file: a Function body starts on its third line. */
function rigLine(prefix: string): number {
  const index = RIG.findIndex((statement) => statement.startsWith(prefix));
  expect(index).toBeGreaterThanOrEqual(0);
  return index + 3;
}

async function summary(): Promise<SceneSummary> {
  const res = await fetch(`${baseUrl}/api/scene/summary`);
  expect(res.status).toBe(200);
  return await res.json() as SceneSummary;
}

/** The connector rows of `objects[]`, by id. */
function connectorRows(body: SceneSummary): Map<string, string> {
  return new Map(body.objects.filter((o) => o.kind === 'connector').map((o) => [o.id, o.params.name]));
}

describe('scene summary joints through the real route', () => {
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

  it('lists every mate and relation, root and generated, with scope, ownership, sides and options', async () => {
    engine._setSceneForTesting(ASSEMBLY_FILE, renderRig());
    const body = await summary();

    expect(body.joints).toEqual({ source: 'statement', solvedIn: 'viewer' });
    const mates = body.mates!;
    expect(mates.map((m) => [m.mateId, m.type, m.name ?? null, m.owner, m.engineOwned ?? false])).toEqual([
      ['mate-0', 'fastened', null, '', false],
      ['mate-1', 'revolute', 'Pivot', '', false],
      ['mate-2', 'slider', null, '', false],
      ['mate-3', 'tangent', null, '', false],
      ['asm-0/mate-0', 'revolute', 'Left door', 'asm-0', true],
      ['asm-0/mate-1', 'revolute', 'Right door', 'asm-0', true],
      ['asm-0/mate-2', 'slider', 'Drawer 1', 'asm-0', true],
      ['mate-4', 'fastened', 'Kitchen on plate', '', false],
    ]);
    // No solve status anywhere: the server never solves.
    for (const m of mates) {
      expect(Object.keys(m)).not.toContain('status');
    }
    const byId = new Map(mates.map((m) => [m.mateId, m]));
    const instanceIds = new Map(body.instances!.map((i) => [i.name, i.instanceId]));
    const connectors = connectorRows(body);

    // An assembly connector on one side, a part connector on the other.
    const fastened = byId.get('mate-0')!;
    expect(fastened.a).toEqual({ kind: 'assembly-connector', connector: 'datum', connectorId: fastened.a.kind === 'assembly-connector' ? fastened.a.connectorId : '' });
    expect(fastened.b).toMatchObject({ kind: 'connector', instanceId: instanceIds.get('Plate'), instance: 'Plate', connector: 'foot' });
    expect(fastened.options).toBeUndefined();
    expect(fastened.ownerName).toBeUndefined();

    // The revolute's limits in degrees, as the mate stores them.
    const pivot = byId.get('mate-1')!;
    expect(pivot.a).toMatchObject({ kind: 'connector', instanceId: 'inst-0', instance: 'Plate', connector: 'pivot' });
    expect(pivot.b).toMatchObject({ kind: 'connector', instanceId: 'inst-1', instance: 'Lever', connector: 'bore' });
    expect(pivot.options).toEqual({ limits: [-30, 90] });
    expect(pivot.sourceLocation).toMatchObject({ filePath: ASSEMBLY_FILE, line: rigLine('const pivot') });

    const slide = byId.get('mate-2')!;
    expect(slide.a).toMatchObject({ instance: 'Plate', connector: 'rail' });
    expect(slide.b).toMatchObject({ instanceId: 'inst-2', instance: 'Carriage', connector: 'shoe' });
    expect(slide.options).toEqual({ flip: true, offset: [0, 0, 5] });

    // A tangent mate's sides are the two exposures.
    const tangent = byId.get('mate-3')!;
    expect(tangent.a).toEqual({ kind: 'exposure', instanceId: 'inst-3', instance: 'Puck', exposure: 'skin' });
    expect(tangent.b).toEqual({ kind: 'exposure', instanceId: 'inst-0', instance: 'Plate', exposure: 'deck' });
    expect(tangent.options).toEqual({ propagate: false });

    // Every connector side names a connector row of objects[] by id, under the label it shows.
    for (const m of mates) {
      for (const side of [m.a, m.b]) {
        if (side.kind !== 'exposure') {
          expect(connectors.get(side.connectorId)).toBe(side.connector);
        }
      }
    }

    // The generator's joints: in the occurrence's scope, engine-owned, at the insert's line.
    const kitchen = body.occurrences!.find((o) => o.name === 'Kitchen')!;
    expect(kitchen).toMatchObject({ occurrenceId: 'asm-0', parentPath: '' });
    expect(kitchen.generated).toEqual({ definition: 'acme.cabinet', values: { ...CABINET_DEFAULTS, drawers: 1 } });
    const kitchenInsert = body.instances!.find((i) => i.owner === 'asm-0')!.sourceLocation;
    expect(kitchenInsert).toMatchObject({ filePath: ASSEMBLY_FILE, line: rigLine('const kitchen') });
    const left = byId.get('asm-0/mate-0')!;
    expect(left).toMatchObject({ owner: 'asm-0', ownerName: 'Kitchen', engineOwned: true });
    expect(left.a).toMatchObject({ kind: 'connector', instanceId: 'asm-0/inst-0', instance: 'Carcass', connector: 'leftHinge' });
    expect(left.b).toMatchObject({ kind: 'connector', instanceId: 'asm-0/inst-1', instance: 'Left door', connector: 'hinge' });
    expect(left.options).toEqual({ limits: [0, CABINET_DEFAULTS.hingeAngle] });
    expect(left.sourceLocation).toEqual(kitchenInsert);
    const right = byId.get('asm-0/mate-1')!;
    expect(right.options).toEqual({ limits: [-CABINET_DEFAULTS.hingeAngle, 0] });
    expect(right.b).toMatchObject({ instanceId: 'asm-0/inst-2', instance: 'Right door', connector: 'hinge' });
    // The two doors are one template: one hinge connector row, two instances.
    expect(right.b.kind === 'connector' && left.b.kind === 'connector' && right.b.connectorId === left.b.connectorId).toBe(true);
    const drawer = byId.get('asm-0/mate-2')!;
    expect(drawer.a).toMatchObject({ instance: 'Carcass', connector: 'runner0' });
    expect(drawer.b).toMatchObject({ instanceId: 'asm-0/inst-3', instance: 'Drawer 1', connector: 'runner' });
    expect(drawer.options).toEqual({ limits: [0, drawerTravel(CABINET_DEFAULTS.depth)] });

    // A root mate onto a generated part is the file's own.
    const onto = byId.get('mate-4')!;
    expect(onto.engineOwned).toBeUndefined();
    expect(onto.b).toMatchObject({ kind: 'connector', instanceId: 'asm-0/inst-0', instance: 'Carcass', connector: 'base' });

    // The generator's parts are engine-owned rows; the file's own are not.
    expect(body.instances!.filter((i) => i.engineOwned).map((i) => i.name)).toEqual(['Carcass', 'Left door', 'Right door', 'Drawer 1']);

    // Relations: the two mates by id and name.
    expect(body.relations).toEqual([
      {
        relationId: 'rel-0', name: 'Drive', type: 'rack-and-pinion', ratio: 62.8, reverse: true,
        mateA: { mateId: 'mate-1', name: 'Pivot' }, mateB: { mateId: 'mate-2' },
        owner: '', sourceLocation: expect.objectContaining({ filePath: ASSEMBLY_FILE, line: rigLine('relation(') }),
      },
      {
        relationId: 'asm-0/rel-0', name: 'Doors together', type: 'gear', ratio: 1, reverse: true,
        mateA: { mateId: 'asm-0/mate-0', name: 'Left door' }, mateB: { mateId: 'asm-0/mate-1', name: 'Right door' },
        owner: 'asm-0', ownerName: 'Kitchen', engineOwned: true, sourceLocation: kitchenInsert,
      },
    ]);
  });

  it('marks a generator\'s joints engine-owned when its defining file renders the layout at the root', async () => {
    const def = cabinetDef();
    const scene = getSceneManager().startAssemblyScene();
    def.run();
    render();
    expect(scene.getRenderedObjects().filter((r) => r.hasError).map((r) => r.errorMessage)).toEqual([]);
    engine._setSceneForTesting(CABINET_FILE, scene);
    const body = await summary();

    expect(body.occurrences).toBeUndefined();
    expect(body.mates!.map((m) => [m.mateId, m.name, m.owner, m.engineOwned])).toEqual([
      ['mate-0', 'Left door', '', true],
      ['mate-1', 'Right door', '', true],
      ['mate-2', 'Drawer 1', '', true],
      ['mate-3', 'Drawer 2', '', true],
    ]);
    expect(body.mates!.every((m: SceneSummaryMate) => m.sourceLocation?.filePath === CABINET_FILE)).toBe(true);
    expect(body.relations!.map((r) => [r.relationId, r.name, r.engineOwned])).toEqual([['rel-0', 'Doors together', true]]);
    expect(body.instances!.every((i) => i.engineOwned === true)).toBe(true);
  });

  it('lists an assembly without joints with an empty mates list and no relations', async () => {
    getSceneManager().startScene();
    const block = part('block', () => {
      sketch('xy', () => { testRect(20, 20); });
      extrude(10);
    });
    const scene = getSceneManager().startAssemblyScene();
    insert(block).grounded().name('Alone');
    render();
    engine._setSceneForTesting(ASSEMBLY_FILE, scene);
    const body = await summary();

    expect(body.joints).toEqual({ source: 'statement', solvedIn: 'viewer' });
    expect(body.mates).toEqual([]);
    expect(Object.keys(body)).not.toContain('relations');
    expect(body.instances!.map((i) => i.engineOwned)).toEqual([undefined]);
  });

  it('a part file\'s summary has no joint keys', async () => {
    part('block', () => {
      sketch('xy', () => { testRect(20, 20); });
      extrude(10);
    });
    engine._setSceneForTesting(PART_FILE, render());
    const body = await summary();
    expect(body.objects.length).toBeGreaterThan(0);
    for (const key of ['joints', 'mates', 'relations', 'instances', 'instancePoses', 'occurrences']) {
      expect(Object.keys(body)).not.toContain(key);
    }
  });
});
