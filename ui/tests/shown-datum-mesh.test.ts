// @vitest-environment jsdom
// A consumed plane or axis the user showed again (the timeline eye, a dialog's
// reveal) draws the quad or line its consumer hid — with its shape id, so the
// viewport can pick and highlight it — while an unshown one draws nothing.
import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { buildSceneMesh } from '../src/meshes/mesh-factory';
import type { SceneObjectRender } from '../src/types';

const loc = { filePath: '/ws/model.fluid.js', line: 2, column: 1 };
const quadMesh = { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3] };
const lineMesh = { vertices: [0, 0, -1, 0, 0, 1], normals: [], indices: [] };

function usedPlane(): SceneObjectRender {
  return {
    id: 'p', name: 'plane', parentId: null, isContainer: false, type: 'plane', uniqueType: 'plane',
    object: { normal: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: 0 } },
    sceneShapes: [], ownShapes: [], visible: false, consumedBy: 's', sourceLocation: loc,
    hiddenShapes: [{ shapeId: 'p-q', shapeType: 'face', isMetaShape: true, isGuide: false, meshes: [quadMesh] } as any],
  } as SceneObjectRender;
}

function usedAxis(): SceneObjectRender {
  return {
    id: 'a', name: 'axis', parentId: null, isContainer: false, type: 'axis', uniqueType: 'axis',
    object: {}, sceneShapes: [], ownShapes: [], visible: false, consumedBy: 'r', sourceLocation: loc,
    hiddenShapes: [{ shapeId: 'a-l', shapeType: 'edge', isMetaShape: true, isGuide: false, meshes: [lineMesh] } as any],
  } as SceneObjectRender;
}

function shapeIdsIn(root: { traverse(cb: (o: any) => void): void }): string[] {
  const ids: string[] = [];
  root.traverse(o => { if (o.userData?.shapeId) ids.push(o.userData.shapeId); });
  return ids;
}

describe('a used plane or axis in the scene mesh', () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);

  it('draws nothing while hidden', () => {
    const mesh = buildSceneMesh([usedPlane(), usedAxis()], null, camera);
    expect(mesh.children).toHaveLength(0);
  });

  it('draws the hidden quad with its shape id when shown', () => {
    const mesh = buildSceneMesh([usedPlane()], null, camera, false, false, new Set(['p']));
    expect(shapeIdsIn(mesh)).toEqual(['p-q']);
  });

  it('draws the hidden line with its shape id when shown', () => {
    const mesh = buildSceneMesh([usedAxis()], null, camera, false, false, new Set(['a']));
    expect(shapeIdsIn(mesh)).toEqual(['a-l']);
  });
});
