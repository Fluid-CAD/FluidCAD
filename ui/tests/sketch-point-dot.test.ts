// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Group, Vector3 } from 'three';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// A `point()` entity is one vertex: a mesh of a single position and no
// polyline. The vertex pass finds a curve's dots at the ends of its
// polyline, so a point had none and was invisible — pickable, but nowhere to
// be seen. This pins that it draws its dot, as a guide too.
// ---------------------------------------------------------------------------

const AT: [number, number, number] = [12, 8, 0];

function pointPayload(guide: boolean): SceneObjectRender[] {
  const sketch: SceneObjectRender = {
    id: 'sk',
    type: 'sketch',
    object: { plane: { normal: { x: 0, y: 0, z: 1 } } },
    sceneShapes: [],
    ownShapes: [],
  };
  const point: SceneObjectRender = {
    id: 'p1',
    parentId: 'sk',
    uniqueType: 'solved-point',
    sceneShapes: [
      {
        shapeId: 'v1',
        shapeType: 'vertex',
        isGuide: guide || undefined,
        meshes: [{ vertices: [...AT], indices: [], normals: [] }],
      },
    ],
    ownShapes: [],
  };
  return [sketch, point];
}

function vertexDots(mesh: SketchMesh): Vector3[] {
  const dots: Vector3[] = [];
  for (const child of mesh.children) {
    if ((child as Group).userData.isVertexDot) {
      dots.push(child.position.clone());
    }
  }
  return dots;
}

function buildMesh(guide: boolean): SketchMesh {
  const [sketch, point] = pointPayload(guide);
  return new SketchMesh(sketch, [sketch, point], null, new PerspectiveCamera());
}

describe('sketch point dot', () => {
  it('draws one dot for a point entity, where the point is', () => {
    const dots = vertexDots(buildMesh(false));
    expect(dots).toHaveLength(1);
    expect(dots[0].distanceTo(new Vector3(...AT))).toBeLessThan(1e-9);
  });

  it('keeps the dot when the point is a guide', () => {
    const dots = vertexDots(buildMesh(true));
    expect(dots).toHaveLength(1);
    expect(dots[0].distanceTo(new Vector3(...AT))).toBeLessThan(1e-9);
  });
});
