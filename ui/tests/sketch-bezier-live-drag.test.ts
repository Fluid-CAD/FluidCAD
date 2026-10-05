// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { BufferAttribute, Line, Object3D, PerspectiveCamera, Texture, Vector3 } from 'three';

// Constraint readouts are text glyphs and jsdom has no canvas 2D context —
// this test is about the curve's live redraw, so label textures are stubbed.
vi.mock('../src/meshes/containers/badge-textures', () => {
  const stub = () => ({ texture: new Texture(), aspect: 1 });
  return { CANVAS_SIZE: 64, getIconTexture: stub, getTextTexture: stub, createTextTexture: stub };
});
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import { tessellateBezier } from '../src/sketch-solver-client/tessellate';
import type { LiveEntityGeometry } from '../src/sketch-solver-client/live-system';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// Live drag (P4/P8) of a bezier: the curve is not a solver entity — its
// literal control points are, one anchor point entity each — so a drag that
// moves a control point must retessellate the curve and move its handles
// (control polygon + dots) every frame. Before this, the curve and handles
// sat still until the commit re-render on mouse-up.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

const CONTROLS: [number, number][] = [[0, 0], [10, 30], [40, 30], [50, 0]];
const SEGMENTS = 12;

/** The kernel's edge tessellation as LineSegments pairs. */
function curveMesh(controls: [number, number][]) {
  const points = tessellateBezier(controls, SEGMENTS)!;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const [i, p] of points.entries()) {
    vertices.push(p[0], p[1], 0);
    if (i > 0) {
      indices.push(i - 1, i);
    }
  }
  return { vertices, indices, normals: [] };
}

function solvedBezierPayload(): SceneObjectRender[] {
  const solver = {
    entities: CONTROLS.map((_, i) => ({ id: i, kind: 'point', fixed: false, paramOffset: i * 2 })),
    params: CONTROLS.flat(),
    constraints: [],
    dof: 8,
    outcome: 'solved',
    underconstrainedEntities: [0, 1, 2, 3],
  };
  const sketch: SceneObjectRender = {
    id: 'sk',
    type: 'sketch',
    uniqueType: 'sketch',
    object: { solvedMode: true, plane: PLANE, solver },
    sceneShapes: [],
    ownShapes: [],
  } as SceneObjectRender;
  const bezier: SceneObjectRender = {
    id: 'bz1',
    parentId: 'sk',
    type: 'bezier',
    uniqueType: 'bezier-4',
    object: {
      startPoint: CONTROLS[0],
      resolvedPoints: CONTROLS.slice(1),
      anchors: CONTROLS.map((p, i) => ({ pointIndex: i, entityId: i, guess: { x: p[0], y: p[1] } })),
      controlSources: CONTROLS.map((_, i) => ({ entityId: i, role: null })),
    },
    sceneShapes: [{ shapeId: 'e1', shapeType: 'edge', meshes: [curveMesh(CONTROLS)] }],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  return [sketch, bezier];
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

function findHandlePolyline(mesh: SketchMesh): Line | null {
  let found: Line | null = null;
  mesh.traverse((child: Object3D) => {
    if (!found && child.userData.isBezierHandle) {
      found = child as Line;
    }
  });
  return found;
}

function dotPositions(mesh: SketchMesh): Vector3[] {
  const dots: Vector3[] = [];
  for (const child of mesh.children) {
    if (child.userData.isVertexDot) {
      dots.push(child.position.clone());
    }
  }
  return dots;
}

/** Every segment start sits on the curve through `controls` (positions
 * are Float32 in the instanced geometry, hence the 4dp tolerance). */
function expectOnBezier(geometry: LineSegmentsGeometry, controls: [number, number][]): void {
  const expected = tessellateBezier(controls, SEGMENTS)!;
  const starts = geometry.attributes.instanceStart;
  expect(starts.count).toBe(SEGMENTS);
  for (let i = 0; i < starts.count; i++) {
    expect(starts.getX(i)).toBeCloseTo(expected[i][0], 4);
    expect(starts.getY(i)).toBeCloseTo(expected[i][1], 4);
  }
}

function liveWith(moved: Record<number, [number, number]>): (id: number) => LiveEntityGeometry {
  return id => ({ kind: 'point', point: moved[id] ?? CONTROLS[id] });
}

describe('bezier live drag', () => {
  it('tessellates a cubic through its control points by de Casteljau', () => {
    const points = tessellateBezier(CONTROLS, 4)!;
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual(CONTROLS[0]);
    expect(points[4]).toEqual(CONTROLS[3]);
    // t = 0.5 of a cubic: (P0 + 3P1 + 3P2 + P3) / 8.
    expect(points[2][0]).toBeCloseTo((0 + 30 + 120 + 50) / 8, 9);
    expect(points[2][1]).toBeCloseTo((0 + 90 + 90 + 0) / 8, 9);
    // A single point is no curve yet.
    expect(tessellateBezier([[1, 2]], 4)).toBeNull();
  });

  it('draws the active sketch\'s control polygon and a dot per control point', () => {
    const [sketch, bezier] = solvedBezierPayload();
    const mesh = new SketchMesh(sketch, [sketch, bezier], 'sk', new PerspectiveCamera());
    expect(mesh.solved?.beziers.get('bz1')?.points).toEqual(CONTROLS);

    const polyline = findHandlePolyline(mesh);
    expect(polyline).not.toBeNull();
    const pos = polyline!.geometry.getAttribute('position') as BufferAttribute;
    expect(pos.count).toBe(CONTROLS.length);
    for (const [i, p] of CONTROLS.entries()) {
      expect(pos.getX(i)).toBeCloseTo(p[0], 9);
      expect(pos.getY(i)).toBeCloseTo(p[1], 9);
    }
    const dots = dotPositions(mesh);
    for (const p of CONTROLS) {
      expect(dots.some(d => d.distanceTo(new Vector3(p[0], p[1], 0)) < 1e-9)).toBe(true);
    }
  });

  it('keeps reference sketches free of handles', () => {
    const [sketch, bezier] = solvedBezierPayload();
    const mesh = new SketchMesh(sketch, [sketch, bezier], 'another-sketch', new PerspectiveCamera());
    expect(findHandlePolyline(mesh)).toBeNull();
  });

  it('retessellates the curve and moves the handles on a live geometry update', () => {
    const [sketch, bezier] = solvedBezierPayload();
    const mesh = new SketchMesh(sketch, [sketch, bezier], 'sk', new PerspectiveCamera());
    const line = findEdgeLine(mesh);
    expect(line).not.toBeNull();
    expectOnBezier(line!.geometry as LineSegmentsGeometry, CONTROLS);

    const moved: [number, number] = [20, 60];
    mesh.updateSolvedGeometry(liveWith({ 1: moved }));

    const controls: [number, number][] = [CONTROLS[0], moved, CONTROLS[2], CONTROLS[3]];
    expectOnBezier(line!.geometry as LineSegmentsGeometry, controls);

    const pos = findHandlePolyline(mesh)!.geometry.getAttribute('position') as BufferAttribute;
    expect(pos.getX(1)).toBeCloseTo(moved[0], 9);
    expect(pos.getY(1)).toBeCloseTo(moved[1], 9);
    const dots = dotPositions(mesh);
    expect(dots.some(d => d.distanceTo(new Vector3(moved[0], moved[1], 0)) < 1e-9)).toBe(true);
    expect(dots.some(d => d.distanceTo(new Vector3(CONTROLS[1][0], CONTROLS[1][1], 0)) < 1e-9)).toBe(false);
  });

  it('redraws the curve of a reference sketch too, handles or not', () => {
    const [sketch, bezier] = solvedBezierPayload();
    const mesh = new SketchMesh(sketch, [sketch, bezier], null, new PerspectiveCamera());
    const line = findEdgeLine(mesh)!;
    const moved: [number, number] = [45, -20];
    mesh.updateSolvedGeometry(liveWith({ 3: moved }));
    expectOnBezier(line.geometry as LineSegmentsGeometry, [CONTROLS[0], CONTROLS[1], CONTROLS[2], moved]);
  });
});
