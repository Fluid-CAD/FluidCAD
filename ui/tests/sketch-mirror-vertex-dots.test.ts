// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Group, Vector3 } from 'three';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// A derived op's solver-backed duplicates (mirror images, copy instances)
// are free entities: pickable, constrainable, dragging their source. Their
// endpoint dots must render at the full interactive size, identical to a
// drawn line's — the dot bucket used to be chosen per OBJECT, and a mirror
// statement is no entity itself, so every image got the small dimmed
// "non-interactive" dot.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

function lineShape(shapeId: string, a: [number, number], b: [number, number]) {
  return {
    shapeId,
    shapeType: 'edge',
    meshes: [{ vertices: [a[0], a[1], 0, b[0], b[1], 0], indices: [0, 1], normals: [] }],
  };
}

function payload(): SceneObjectRender[] {
  const solver = {
    entities: [
      { id: 0, kind: 'line', fixed: false, paramOffset: 0 },
      { id: 7, kind: 'line', fixed: false, paramOffset: 4 },
    ],
    constraints: [],
    params: [10, 0, 30, 0, -10, 0, -30, 0],
    outcome: 'solved', dof: 8, conflicting: [], redundant: [], underconstrainedEntities: [0, 7],
  };
  const sketch = {
    id: 'sk', type: 'sketch', uniqueType: 'sketch',
    object: { plane: PLANE, solvedMode: true, solver },
    sceneShapes: [], ownShapes: [],
  } as unknown as SceneObjectRender;
  const source = {
    id: 'l', parentId: 'sk', type: 'line', uniqueType: 'solved-line',
    object: { entityId: 0, start: { x: 10, y: 0 }, end: { x: 30, y: 0 } },
    sceneShapes: [lineShape('e-src', [10, 0], [30, 0])],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  const mirror = {
    id: 'm', parentId: 'sk', type: 'mirror', uniqueType: 'mirror-shape-2d',
    object: {
      sourceEntities: [0], sourcesSolved: true,
      entities: [{ entityId: 7, kind: 'line', shapeIndex: 0, sourceEntityId: 0 }],
    },
    sceneShapes: [lineShape('e-img', [-10, 0], [-30, 0])],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  return [sketch, source, mirror];
}

function dotRadii(mesh: SketchMesh): Map<string, number> {
  const out = new Map<string, number>();
  for (const child of mesh.children) {
    if ((child as Group).userData.isVertexDot) {
      const p = child.position;
      out.set(`${p.x},${p.y}`, (child as Group).userData.pxRadius as number);
    }
  }
  return out;
}

describe('sketch mirror image vertex dots', () => {
  it('renders image endpoints at the same size as the drawn source endpoints', () => {
    const [sketch, source, mirror] = payload();
    const mesh = new SketchMesh(sketch, [sketch, source, mirror], null, new PerspectiveCamera());
    const radii = dotRadii(mesh);
    const src = radii.get('10,0');
    expect(src).toBeGreaterThan(0);
    expect(radii.get('30,0')).toBe(src);
    expect(radii.get('-10,0')).toBe(src);
    expect(radii.get('-30,0')).toBe(src);
    expect(new Vector3(-30, 0, 0).length()).toBe(30);
  });
});
