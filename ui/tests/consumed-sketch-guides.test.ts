// @vitest-environment jsdom
// A feature consumes a sketch's profile, never its guides: the engine leaves
// the guide shapes on their rows while the sketch row reads consumed
// (visible false, consumedBy set). The scene mesh still draws those guides,
// and their endpoints join the vertex pick channel — the construction
// geometry a hole's placements are picked on.
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { buildSceneMesh } from '../src/meshes/mesh-factory';
import { collectPickCandidates } from '../src/interactive/pick-candidates';
import { themeColors } from '../src/scene/theme-colors';
import type { SceneObjectRender } from '../src/types';

const loc = { filePath: '/ws/model.fluid.js', line: 1, column: 1 };
const channels = { sketchWires: false, profileWires: false, axes: false, planes: false, vertices: true };

function consumedSketch(withGuide: boolean): SceneObjectRender[] {
  const sketch = {
    id: 'sk', name: 'sketch', parentId: null, isContainer: true, type: 'sketch', uniqueType: 'sketch',
    object: { plane: { normal: { x: 0, y: 0, z: 1 } } },
    sceneShapes: [], ownShapes: [], visible: false, consumedBy: 'ex', sourceLocation: loc,
  } as unknown as SceneObjectRender;
  const guide = {
    id: 'g', name: 'line', parentId: 'sk', isContainer: false, type: 'line', uniqueType: 'solved-line',
    object: {}, ownShapes: [], visible: withGuide, sourceLocation: { ...loc, line: 2 },
    sceneShapes: withGuide ? [{
      shapeId: 'g-e', shapeType: 'edge', isGuide: true, vertices: [-10, 5, 0, 10, 5, 0],
      meshes: [{ vertices: [-10, 5, 0, 10, 5, 0], indices: [0, 1], normals: [] }],
    }] : [],
  } as unknown as SceneObjectRender;
  const profile = {
    id: 'c', name: 'circle', parentId: 'sk', isContainer: false, type: 'circle', uniqueType: 'solved-circle',
    object: {}, ownShapes: [], visible: false, sourceLocation: { ...loc, line: 3 }, sceneShapes: [],
    hiddenShapes: [{
      shapeId: 'c-e', shapeType: 'edge', vertices: [20, 0, 0],
      meshes: [{ vertices: [20, 0, 0, 0, 20, 0, -20, 0, 0], indices: [0, 1, 1, 2], normals: [] }],
    }],
  } as unknown as SceneObjectRender;
  return [sketch, guide, profile];
}

describe('a consumed sketch with guides', () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);

  it('draws nothing when it has no guides', () => {
    const mesh = buildSceneMesh(consumedSketch(false), null, camera);
    expect(mesh.children).toHaveLength(0);
  });

  it('draws the guide over the model in the sketch-mode guide color', () => {
    const mesh = buildSceneMesh(consumedSketch(true), null, camera);
    const lines: any[] = [];
    mesh.traverse(o => { if (o.userData.isDashDotEdgeLine) lines.push(o); });
    expect(lines).toHaveLength(1);
    expect(lines[0].material.depthTest).toBe(false);
    expect(lines[0].material.uniforms.color.value.getHexString()).toBe(themeColors.metaEdgeColor.getHexString());
  });

  it('offers the guide endpoints, and only them, to the vertex pick channel', () => {
    const mesh = buildSceneMesh(consumedSketch(true), null, camera);
    mesh.updateMatrixWorld(true);
    const vertices = collectPickCandidates(mesh, channels).vertices;
    expect(vertices.map(v => [v.shapeId, v.index, v.position.toArray()])).toEqual([
      ['g-e', 0, [-10, 5, 0]],
      ['g-e', 1, [10, 5, 0]],
    ]);
  });
});
