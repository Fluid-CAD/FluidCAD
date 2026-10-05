// @vitest-environment jsdom
// A sketch's guides follow the sketch. While it is on screen they draw over
// the model and their endpoints join the vertex pick channel — the
// construction geometry a hole's placements are picked on. A feature that
// consumes the sketch hides the guides with the profile (the engine moves
// both to `hiddenShapes`), and the timeline eye draws both again.
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { buildSceneMesh } from '../src/meshes/mesh-factory';
import { collectPickCandidates } from '../src/interactive/pick-candidates';
import { themeColors } from '../src/scene/theme-colors';
import type { SceneObjectRender } from '../src/types';

const loc = { filePath: '/ws/model.fluid.js', line: 1, column: 1 };
const channels = { sketchWires: false, profileWires: false, axes: false, planes: false, vertices: true };

const guideShape = {
  shapeId: 'g-e', shapeType: 'edge', isGuide: true, vertices: [-10, 5, 0, 10, 5, 0],
  meshes: [{ vertices: [-10, 5, 0, 10, 5, 0], indices: [0, 1], normals: [] }],
};
const profileShape = {
  shapeId: 'c-e', shapeType: 'edge', vertices: [20, 0, 0],
  meshes: [{ vertices: [20, 0, 0, 0, 20, 0, -20, 0, 0], indices: [0, 1, 1, 2], normals: [] }],
};

function sketchRows(consumed: boolean): SceneObjectRender[] {
  const shapes = (shape: object) => consumed
    ? { sceneShapes: [], hiddenShapes: [shape], visible: false }
    : { sceneShapes: [shape], visible: true };
  const sketch = {
    id: 'sk', name: 'sketch', parentId: null, isContainer: true, type: 'sketch', uniqueType: 'sketch',
    object: { plane: { normal: { x: 0, y: 0, z: 1 } } },
    sceneShapes: [], ownShapes: [], visible: !consumed, consumedBy: consumed ? 'ex' : undefined, sourceLocation: loc,
  } as unknown as SceneObjectRender;
  const guide = {
    id: 'g', name: 'line', parentId: 'sk', isContainer: false, type: 'line', uniqueType: 'solved-line',
    object: {}, ownShapes: [], sourceLocation: { ...loc, line: 2 }, ...shapes(guideShape),
  } as unknown as SceneObjectRender;
  const profile = {
    id: 'c', name: 'circle', parentId: 'sk', isContainer: false, type: 'circle', uniqueType: 'solved-circle',
    object: {}, ownShapes: [], sourceLocation: { ...loc, line: 3 }, ...shapes(profileShape),
  } as unknown as SceneObjectRender;
  return [sketch, guide, profile];
}

function guideLines(mesh: ReturnType<typeof buildSceneMesh>): any[] {
  const lines: any[] = [];
  mesh.traverse(o => { if (o.userData.isDashDotEdgeLine) lines.push(o); });
  return lines;
}

function guideEndpoints(mesh: ReturnType<typeof buildSceneMesh>) {
  mesh.updateMatrixWorld(true);
  return collectPickCandidates(mesh, channels).vertices
    .filter(v => v.shapeId === 'g-e')
    .map(v => [v.index, v.position.toArray()]);
}

describe('a sketch with guides', () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);

  it('draws the guide of a sketch on screen over the model in the sketch-mode guide color', () => {
    const lines = guideLines(buildSceneMesh(sketchRows(false), null, camera));
    expect(lines).toHaveLength(1);
    expect(lines[0].material.depthTest).toBe(false);
    expect(lines[0].material.uniforms.color.value.getHexString()).toBe(themeColors.metaEdgeColor.getHexString());
  });

  it('offers the guide endpoints of a sketch on screen to the vertex pick channel', () => {
    expect(guideEndpoints(buildSceneMesh(sketchRows(false), null, camera))).toEqual([
      [0, [-10, 5, 0]],
      [1, [10, 5, 0]],
    ]);
  });

  it('hides the guides of a consumed sketch with it', () => {
    const mesh = buildSceneMesh(sketchRows(true), null, camera);
    expect(mesh.children).toHaveLength(0);
    expect(guideEndpoints(mesh)).toEqual([]);
  });

  it('draws the guides again, pickable, when the consumed sketch is shown', () => {
    const mesh = buildSceneMesh(sketchRows(true), null, camera, false, false, new Set(['sk']));
    expect(guideLines(mesh)).toHaveLength(1);
    expect(guideEndpoints(mesh)).toEqual([
      [0, [-10, 5, 0]],
      [1, [10, 5, 0]],
    ]);
  });
});
