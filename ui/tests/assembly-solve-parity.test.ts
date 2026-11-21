import { describe, expect, it } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import select from '../../lib/core/select.js';
import part from '../../lib/core/part.js';
import connector from '../../lib/core/connector.js';
import copy from '../../lib/core/copy.js';
import expose from '../../lib/core/expose.js';
import insert from '../../lib/core/insert.js';
import mate from '../../lib/core/mate.js';
import relation from '../../lib/core/relation.js';
import { face } from '../../lib/filters/index.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import type { AssemblyScene } from '../../lib/rendering/assembly-scene.js';
import { AssemblySolverModel, Solver } from '../../lib/assembly-solver/index.js';
import { PartMateGeometryReader } from '../src/scene/part-mate-geometry';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// The viewer and the engine each solve an assembly: the viewer on every
// drag frame, the engine once per render for everything server-side that
// asks where the parts sit. Both build the solver's input with
// AssemblySolverModel — the viewer from the render's rows, the engine from
// its own scene — so a freshly opened viewer and the engine must land every
// part on exactly the same pose. Each case here renders a real assembly,
// puts its payload through JSON the way a render reaches the page, solves
// it the way the viewer does, and compares the two solves number for number.

type Handle = ReturnType<typeof insert>;

/** A 20×20×10 block: connectors on its top and bottom faces, the top face exposed. */
function blockDefinition() {
  return part('block', () => {
    sketch('xy', () => { testRect(20, 20); });
    extrude(10);
    connector('top', select(face().planar().onPlane('xy', 10)));
    connector('bottom', select(face().planar().onPlane('xy', 0)));
    expose('lid', select(face().planar().onPlane('xy', 10)));
  });
}

/** A 100×100×10 plate with a `bolt` connector 30 along X on its top face, copied round Z. */
function flangeDefinition() {
  return part('flange', () => {
    sketch('xy', () => { testRect(100, 100, { at: [-50, -50] }); });
    extrude(10);
    const bolt = (connector('bolt', select(face().planar().onPlane('xy', 10))) as any).offset(30, 0, 0);
    copy('circular', 'z', { count: 4, angle: 360 }, bolt);
  });
}

const manager = () => getSceneManager()!;

function startAssembly(): AssemblyScene {
  manager().startScene();
  return manager().startAssemblyScene() as AssemblyScene;
}

/** The solve a viewer runs on the render it just received. */
function viewerSolve(scene: AssemblyScene) {
  const rows: SceneObjectRender[] = JSON.parse(JSON.stringify(scene.getRenderedObjects()));
  const assembly: SerializedAssembly = JSON.parse(JSON.stringify(manager().getAssemblyData(scene)));
  const model = new AssemblySolverModel({
    instances: assembly.instances,
    mates: assembly.mates,
    relations: assembly.relations,
    connectors: assembly.connectors,
    partGeometry: partId => PartMateGeometryReader.of(rows, partId),
  });
  const output = new Solver().solve(model.input());
  const instanceIds = new Set(assembly.instances.map(i => i.instanceId));
  return {
    output,
    poses: output.bodies.filter(b => instanceIds.has(b.instanceId)).map(b => ({
      instanceId: b.instanceId,
      position: { x: b.position.x, y: b.position.y, z: b.position.z },
      quaternion: { x: b.quaternion.x, y: b.quaternion.y, z: b.quaternion.z, w: b.quaternion.w },
    })),
  };
}

function expectSameSolve(scene: AssemblyScene): ReturnType<AssemblyScene['getSolution']> {
  const engine = scene.getSolution();
  const viewer = viewerSolve(scene);
  expect(engine.posesSource).toBe('solved');
  expect(engine.status).toBe(viewer.output.result);
  expect(engine.dof).toBe(viewer.output.dof);
  expect(engine.poses).toEqual(viewer.poses);
  expect(engine.mates.filter(m => m.status === 'failed').map(m => m.mateId)).toEqual(viewer.output.failed);
  expect(engine.mates.filter(m => m.status === 'unenforced').map(m => m.mateId)).toEqual(viewer.output.unenforced);
  return engine;
}

describe('the engine and the viewer solve an assembly identically', () => {
  setupOC();

  it('a grounded chain of fastened and revolute mates', () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const middle = insert(block).translate(60, -20, 15).rotate('x', 20);
    const lid = insert(block).translate(-40, 30, 80);
    mate('fastened', base.connectors.top, middle.connectors.bottom).rotate(30);
    mate('revolute', middle.connectors.top, lid.connectors.bottom).limits(10, 45);
    render();

    const engine = expectSameSolve(scene);
    expect(engine.status).toBe('okay');
    expect(engine.mates.map(m => m.status)).toEqual(['satisfied', 'satisfied']);
  });

  it('an ungrounded assembly, whose roots are picked by record order', () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const parts: Handle[] = [];
    for (let i = 0; i < 4; i++) {
      parts.push(insert(block).translate(35 * i, 12 * i, -8 * i).rotate('z', 17 * i));
    }
    // Two separate pairs, mated out of insert order.
    mate('slider', parts[3].connectors.top, parts[1].connectors.bottom);
    mate('cylindrical', parts[2].connectors.top, parts[0].connectors.bottom);
    render();

    expectSameSolve(scene);
  });

  it('a mate on an assembly connector and one on a connector copy', () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const flange = flangeDefinition();
    const hinge = (connector('hinge', [40, 0, 12]) as any).rotate('x', 90);
    const plate = insert(flange).translate(0, 0, 50);
    const stud = insert(block).translate(-70, 20, 5);
    mate('revolute', hinge, plate.connectors.bolt);
    mate('fastened', (plate.connectors.bolt as any).instance(2), stud.connectors.bottom);
    render();

    const engine = expectSameSolve(scene);
    expect(engine.mates.map(m => m.status)).toEqual(['satisfied', 'satisfied']);
  });

  it('a tangent mate on exposed geometry', () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const rider = insert(block).translate(5, 5, 40).rotate('x', 170);
    mate('tangent', base.features.lid, rider.features.lid);
    render();

    const engine = expectSameSolve(scene);
    expect(engine.mates).toHaveLength(1);
    expect(engine.mates[0].status).not.toBe('unenforced');
  });

  it('two hinges coupled by a gear relation', () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const upper = insert(block).translate(0, 0, 30);
    const lower = insert(block).translate(0, 0, -30);
    const hingeA = mate('revolute', base.connectors.top, upper.connectors.bottom);
    const hingeB = mate('revolute', base.connectors.bottom, lower.connectors.top);
    relation('gear', hingeA, hingeB, 2);
    render();

    const engine = expectSameSolve(scene);
    expect(engine.relations).toEqual([{ relationId: 'rel-0', status: 'satisfied' }]);
  });

  it('a mate nothing can close', () => {
    const scene = startAssembly();
    const block = blockDefinition();
    const base = insert(block).grounded();
    const lid = insert(block).translate(0, 0, 40).grounded();
    mate('fastened', base.connectors.top, lid.connectors.bottom);
    render();

    const engine = expectSameSolve(scene);
    expect(engine.status).toBe('inconsistent');
  });
});
