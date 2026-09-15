// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import { tessellateSolvedEntity } from '../src/sketch-solver-client/tessellate';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// Live drag (P4) of an ellipse's center (P8 anchor point). The perimeter
// edge is registered under the center's entity id, but the center is a
// POINT entity — which tessellates to nothing — so the edge used to sit
// still until the commit re-render while only the center dot moved. The
// view now carries the statement's radii and the edge redraws per frame.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

const CENTER: [number, number] = [5, 7];
const RX = 4;
const RY = 2;
const SEGMENTS = 16;

function ellipseMesh(center: [number, number]) {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    vertices.push(center[0] + RX * Math.cos(a), center[1] + RY * Math.sin(a), 0);
    indices.push(i, (i + 1) % SEGMENTS);
  }
  return { vertices, indices, normals: [] };
}

function solvedEllipsePayload(): SceneObjectRender[] {
  const solver = {
    entities: [{ id: 0, kind: 'point', fixed: false, paramOffset: 0 }],
    params: [CENTER[0], CENTER[1]],
    constraints: [],
    dof: 2,
    outcome: 'solved',
    underconstrainedEntities: [0],
  };
  const sketch: SceneObjectRender = {
    id: 'sk',
    type: 'sketch',
    uniqueType: 'sketch',
    object: { solvedMode: true, plane: PLANE, solver },
    sceneShapes: [],
    ownShapes: [],
  } as SceneObjectRender;
  const ellipse: SceneObjectRender = {
    id: 'el1',
    parentId: 'sk',
    type: 'ellipse',
    uniqueType: 'ellipse',
    object: {
      rx: RX, ry: RY, center: { x: CENTER[0], y: CENTER[1] },
      entityId: 0, guess: { center: { x: CENTER[0], y: CENTER[1] } },
    },
    sceneShapes: [
      { shapeId: 'e1', shapeType: 'edge', meshes: [ellipseMesh(CENTER)] },
      { isMetaShape: true, meshes: [{ vertices: [CENTER[0], CENTER[1], 0], indices: [], normals: [] }] },
    ],
    ownShapes: [],
  } as SceneObjectRender;
  return [sketch, ellipse];
}

function findEdgeLine(mesh: SketchMesh): LineSegments2 | null {
  let found: LineSegments2 | null = null;
  mesh.traverse((child: Object3D) => {
    if (!found && child.userData.isEdgeLine) {
      found = child as LineSegments2;
    }
  });
  return found;
}

/** Every segment endpoint sits on the ellipse `((x-cx)/rx)² + ((y-cy)/ry)² = 1`. */
function expectOnEllipse(geometry: LineSegmentsGeometry, center: [number, number]): void {
  const starts = geometry.attributes.instanceStart;
  expect(starts.count).toBe(SEGMENTS);
  for (let i = 0; i < starts.count; i++) {
    const u = (starts.getX(i) - center[0]) / RX;
    const v = (starts.getY(i) - center[1]) / RY;
    expect(u * u + v * v).toBeCloseTo(1, 6);
  }
}

describe('ellipse center live drag', () => {
  it('tessellates an ellipse anchor view around its live center', () => {
    const points = tessellateSolvedEntity({ entityId: 0, kind: 'point', point: [1, 2], radii: [3, 1] }, 8);
    expect(points).toHaveLength(9);
    expect(points![0]).toEqual([4, 2]);
    expect(points![2][0]).toBeCloseTo(1, 9);
    expect(points![2][1]).toBeCloseTo(3, 9);
    // A plain point (no radii) still draws no edge.
    expect(tessellateSolvedEntity({ entityId: 0, kind: 'point', point: [1, 2] }, 8)).toBeNull();
  });

  it('redraws the perimeter edge on a live geometry update', () => {
    const [sketch, ellipse] = solvedEllipsePayload();
    const mesh = new SketchMesh(sketch, [sketch, ellipse], null, new PerspectiveCamera());
    expect(mesh.solved?.entities.get(0)?.radii).toEqual([RX, RY]);

    const line = findEdgeLine(mesh);
    expect(line).not.toBeNull();
    expectOnEllipse(line!.geometry as LineSegmentsGeometry, CENTER);

    const moved: [number, number] = [12, -3];
    mesh.updateSolvedGeometry(() => ({ kind: 'point', point: moved }));

    expectOnEllipse(line!.geometry as LineSegmentsGeometry, moved);
  });

  it('moves the center dot with the live update', () => {
    const [sketch, ellipse] = solvedEllipsePayload();
    const mesh = new SketchMesh(sketch, [sketch, ellipse], null, new PerspectiveCamera());

    const moved: [number, number] = [12, -3];
    mesh.updateSolvedGeometry(() => ({ kind: 'point', point: moved }));

    const dots: Vector3[] = [];
    for (const child of mesh.children) {
      if (child.userData.isVertexDot) {
        dots.push(child.position.clone());
      }
    }
    expect(dots.some(p => p.distanceTo(new Vector3(moved[0], moved[1], 0)) < 1e-9)).toBe(true);
  });
});
