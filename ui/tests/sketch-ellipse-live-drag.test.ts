// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Texture, Vector3 } from 'three';

// The ellipse's RX/RY readouts are text glyphs, and jsdom has no canvas 2D
// context to rasterize a label with — this test is about the perimeter's
// live redraw, so the label textures are stubbed.
vi.mock('../src/meshes/containers/badge-textures', () => {
  const stub = () => ({ texture: new Texture(), aspect: 1 });
  return { CANVAS_SIZE: 64, getIconTexture: stub, getTextTexture: stub, createTextTexture: stub };
});
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import { tessellateSolvedEntity } from '../src/sketch-solver-client/tessellate';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// Live drag (P4) of an ellipse: a solver entity [cx, cy, rx, ry, θ] whose
// perimeter redraws every frame from the live pose (center + rotation)
// around its locked radii, and whose center dot rides along.
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
const DEG = Math.PI / 180;

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
    entities: [{ id: 0, kind: 'ellipse', fixed: false, paramOffset: 0 }],
    params: [CENTER[0], CENTER[1], RX, RY, 0],
    constraints: [],
    dof: 3,
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
    uniqueType: 'solved-ellipse',
    object: {
      rx: RX, ry: RY, center: { x: CENTER[0], y: CENTER[1] }, rotation: 0,
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

/** Every segment endpoint sits on the ellipse of pose (center, θ):
 * `(x'/rx)² + (y'/ry)² = 1` in the rotated frame. */
function expectOnEllipse(geometry: LineSegmentsGeometry, center: [number, number], theta = 0): void {
  const starts = geometry.attributes.instanceStart;
  expect(starts.count).toBe(SEGMENTS);
  for (let i = 0; i < starts.count; i++) {
    const dx = starts.getX(i) - center[0];
    const dy = starts.getY(i) - center[1];
    const u = (dx * Math.cos(theta) + dy * Math.sin(theta)) / RX;
    const v = (-dx * Math.sin(theta) + dy * Math.cos(theta)) / RY;
    expect(u * u + v * v).toBeCloseTo(1, 6);
  }
}

describe('ellipse live drag', () => {
  it('tessellates an ellipse view from its live pose', () => {
    const points = tessellateSolvedEntity({ entityId: 0, kind: 'ellipse', center: [1, 2], radii: [3, 1] }, 8);
    expect(points).toHaveLength(9);
    expect(points![0]).toEqual([4, 2]);
    expect(points![2][0]).toBeCloseTo(1, 9);
    expect(points![2][1]).toBeCloseTo(3, 9);
    // Rotated a quarter turn: RX now runs along y.
    const turned = tessellateSolvedEntity(
      { entityId: 0, kind: 'ellipse', center: [1, 2], radii: [3, 1], theta: 90 * DEG }, 8,
    )!;
    expect(turned[0][0]).toBeCloseTo(1, 9);
    expect(turned[0][1]).toBeCloseTo(5, 9);
    // A plain point draws no edge; an ellipse without radii neither.
    expect(tessellateSolvedEntity({ entityId: 0, kind: 'point', point: [1, 2] }, 8)).toBeNull();
    expect(tessellateSolvedEntity({ entityId: 0, kind: 'ellipse', center: [1, 2] }, 8)).toBeNull();
  });

  it('redraws the perimeter edge on a live geometry update, rotation included', () => {
    const [sketch, ellipse] = solvedEllipsePayload();
    const mesh = new SketchMesh(sketch, [sketch, ellipse], null, new PerspectiveCamera());
    const view = mesh.solved?.entities.get(0);
    expect(view?.kind).toBe('ellipse');
    expect(view?.radii).toEqual([RX, RY]);
    expect(view?.theta).toBe(0);

    const line = findEdgeLine(mesh);
    expect(line).not.toBeNull();
    expectOnEllipse(line!.geometry as LineSegmentsGeometry, CENTER);

    const moved: [number, number] = [12, -3];
    const theta = 30 * DEG;
    mesh.updateSolvedGeometry(() => ({ kind: 'ellipse', center: moved, radii: [RX, RY], theta }));

    expectOnEllipse(line!.geometry as LineSegmentsGeometry, moved, theta);
  });

  it('moves the center dot with the live update', () => {
    const [sketch, ellipse] = solvedEllipsePayload();
    const mesh = new SketchMesh(sketch, [sketch, ellipse], null, new PerspectiveCamera());

    const moved: [number, number] = [12, -3];
    mesh.updateSolvedGeometry(() => ({ kind: 'ellipse', center: moved, radii: [RX, RY], theta: 0 }));

    const dots: Vector3[] = [];
    for (const child of mesh.children) {
      if (child.userData.isVertexDot) {
        dots.push(child.position.clone());
      }
    }
    expect(dots.some(p => p.distanceTo(new Vector3(moved[0], moved[1], 0)) < 1e-9)).toBe(true);
  });
});
