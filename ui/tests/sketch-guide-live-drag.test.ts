// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { BufferAttribute, Line, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// Live drag (P4) rewrites solved-entity meshes in place on every pointermove.
// Guide entities render as dash-dot polylines (MetaEdgeMesh) instead of
// EdgeMesh — this pins the regression where they were never registered for
// live updates, so a dragged guide circle sat still until the commit
// re-render on mouse-up.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

const CENTER: [number, number] = [5, 7];
const RADIUS = 2;
const SEGMENTS = 8;

/** Closed circle tessellation as LineSegments pairs, the backend's format. */
function circleMesh(center: [number, number], radius: number) {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    vertices.push(center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a), 0);
    indices.push(i, (i + 1) % SEGMENTS);
  }
  return { vertices, indices, normals: [] };
}

function solvedGuideCirclePayload(): SceneObjectRender[] {
  const sketch: SceneObjectRender = {
    id: 'sk',
    type: 'sketch',
    object: { solvedMode: true, plane: PLANE },
    sceneShapes: [],
    ownShapes: [],
  };
  const circle: SceneObjectRender = {
    id: 'c1',
    parentId: 'sk',
    uniqueType: 'solved-circle',
    object: { entityId: 0, center: { x: CENTER[0], y: CENTER[1] }, diameter: RADIUS * 2 },
    sceneShapes: [
      {
        shapeId: 'e1',
        shapeType: 'edge',
        isGuide: true,
        meshes: [circleMesh(CENTER, RADIUS)],
      },
      {
        isMetaShape: true,
        isGuide: true,
        meshes: [{ vertices: [CENTER[0], CENTER[1], 0], indices: [], normals: [] }],
      },
    ],
    ownShapes: [],
  };
  return [sketch, circle];
}

function findDashDotLine(mesh: SketchMesh): Line | null {
  let found: Line | null = null;
  mesh.traverse((child: Object3D) => {
    if (!found && child.userData.isDashDotEdgeLine) {
      found = child as Line;
    }
  });
  return found;
}

describe('sketch guide live drag', () => {
  it('rewrites the guide dash-dot polyline on a live geometry update', () => {
    const [sketch, circle] = solvedGuideCirclePayload();
    const mesh = new SketchMesh(sketch, [sketch, circle], null, new PerspectiveCamera());

    const line = findDashDotLine(mesh);
    expect(line).not.toBeNull();

    const moved: [number, number] = [10, 3];
    mesh.updateSolvedGeometry(() => ({ kind: 'circle', center: moved, radius: RADIUS }));

    const posAttr = line!.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      const dx = posAttr.getX(i) - moved[0];
      const dy = posAttr.getY(i) - moved[1];
      expect(Math.hypot(dx, dy)).toBeCloseTo(RADIUS, 6);
    }
  });

  it('moves the guide center dot with the live update', () => {
    const [sketch, circle] = solvedGuideCirclePayload();
    const mesh = new SketchMesh(sketch, [sketch, circle], null, new PerspectiveCamera());

    const moved: [number, number] = [10, 3];
    mesh.updateSolvedGeometry(() => ({ kind: 'circle', center: moved, radius: RADIUS }));

    const dots: Vector3[] = [];
    for (const child of mesh.children) {
      if (child.userData.isVertexDot) {
        dots.push(child.position.clone());
      }
    }
    expect(dots.some(p => p.distanceTo(new Vector3(moved[0], moved[1], 0)) < 1e-9)).toBe(true);
  });
});
