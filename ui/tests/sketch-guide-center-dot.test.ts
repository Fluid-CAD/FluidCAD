// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Group, Vector3 } from 'three';
import { SketchMesh } from '../src/meshes/containers/sketch-mesh';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// Guiding an entity marks every shape it owns as a guide — including the
// meta center vertex a circle/arc/ellipse emits. The center is still a
// solver point (draggable, constrainable), so its dot must survive the
// conversion; this pins the regression where the guide skip in
// buildVertices dropped it before the meta-vertex branch ran.
// ---------------------------------------------------------------------------

const CENTER: [number, number, number] = [5, 7, 0];

function circlePayload(guide: boolean): SceneObjectRender[] {
  const sketch: SceneObjectRender = {
    id: 'sk',
    type: 'sketch',
    object: { plane: { normal: { x: 0, y: 0, z: 1 } } },
    sceneShapes: [],
    ownShapes: [],
  };
  const circle: SceneObjectRender = {
    id: 'c1',
    parentId: 'sk',
    uniqueType: 'solved-circle',
    sceneShapes: [
      {
        shapeId: 'e1',
        shapeType: 'edge',
        isGuide: guide || undefined,
        // A short open polyline stands in for the perimeter tessellation —
        // the test only cares about the vertex pass, not the edge mesh.
        meshes: [{ vertices: [4, 7, 0, 6, 7, 0], indices: [0, 1], normals: [] }],
      },
      {
        isMetaShape: true,
        isGuide: guide || undefined,
        meshes: [{ vertices: [...CENTER], indices: [], normals: [] }],
      },
    ],
    ownShapes: [],
  };
  return [sketch, circle];
}

function vertexDotPositions(mesh: SketchMesh): Vector3[] {
  const dots: Vector3[] = [];
  for (const child of mesh.children) {
    if ((child as Group).userData.isVertexDot) {
      dots.push(child.position.clone());
    }
  }
  return dots;
}

function buildMesh(guide: boolean): SketchMesh {
  const [sketch, circle] = circlePayload(guide);
  return new SketchMesh(sketch, [sketch, circle], null, new PerspectiveCamera());
}

describe('sketch guide center dot', () => {
  it('renders the circle center dot for a plain circle', () => {
    const dots = vertexDotPositions(buildMesh(false));
    expect(dots.some(p => p.distanceTo(new Vector3(...CENTER)) < 1e-9)).toBe(true);
  });

  it('keeps the center dot when the circle is converted to a guide', () => {
    const dots = vertexDotPositions(buildMesh(true));
    expect(dots.some(p => p.distanceTo(new Vector3(...CENTER)) < 1e-9)).toBe(true);
  });
});
