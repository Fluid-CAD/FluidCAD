// @vitest-environment jsdom
// The viewer's shapes-panel callbacks stay shape-id based while the state
// behind them is keyed by lineage: hide a body, render again with new shape
// ids, and the new id reads hidden and its new mesh is hidden on arrival.
import { describe, expect, it, vi } from 'vitest';
import { Viewer } from '../src/viewer';
import { LineageShapeState } from '../src/scene/shape-state';
import type { SceneObjectRender } from '../src/types';

const KEY = 'extrude@/ws/bracket.fluid.js:2:0:1';

type FakeMesh = { userData: { shapeId: string }; visible: boolean; material: { transparent: boolean; opacity: number; depthWrite: boolean; needsUpdate: boolean }; traverse(cb: (o: FakeMesh) => void): void };

function mesh(shapeId: string): FakeMesh {
  const m: FakeMesh = {
    userData: { shapeId },
    visible: true,
    material: { transparent: false, opacity: 1, depthWrite: true, needsUpdate: false },
    traverse(cb) { cb(m); },
  };
  return m;
}

function render(shapeId: string): SceneObjectRender {
  return {
    id: 'e', name: 'Extrude 1', type: 'extrude', uniqueType: 'extrude', parentId: null,
    sceneShapes: [{ shapeId, lineageKey: KEY, shapeType: 'solid', meshes: [] }], ownShapes: [],
  } as unknown as SceneObjectRender;
}

/** A viewer stand-in holding only what the shape-state methods touch, over `meshes` as its scene. */
function viewerOver(meshes: FakeMesh[]) {
  const viewer = Object.create(Viewer.prototype) as Viewer & Record<string, unknown>;
  Object.assign(viewer, {
    shapeState: new LineageShapeState(),
    ctx: { scene: { traverse: (cb: (o: FakeMesh) => void) => meshes.forEach(cb) }, requestRender: vi.fn() },
    applyConnectorVisibility: vi.fn(),
    notifySceneMesh: vi.fn(),
  });
  const adopt = (scene: SceneObjectRender[]) => (viewer as any).applyShapeOverridesAndPrune(scene);
  return { viewer, adopt };
}

describe('viewer shape state', () => {
  it('hides the body under its new shape id after a render that re-minted it', () => {
    const meshes = [mesh('old')];
    const { viewer, adopt } = viewerOver(meshes);
    adopt([render('old')]);

    viewer.setShapeVisibility('old', false);
    expect(viewer.isShapeHidden('old')).toBe(true);
    expect(meshes[0].visible).toBe(false);

    meshes.splice(0, 1, mesh('new'));
    adopt([render('new')]);
    expect(viewer.isShapeHidden('new')).toBe(true);
    expect(viewer.isShapeHidden('old')).toBe(false);
    expect(meshes[0].visible).toBe(false);
  });

  it('fades the body under its new shape id, and reset-all clears it', () => {
    const meshes = [mesh('old')];
    const { viewer, adopt } = viewerOver(meshes);
    adopt([render('old')]);

    viewer.setShapeTransparency('old', 0.3);
    expect(viewer.getShapeTransparency('old')).toBe(0.3);

    meshes.splice(0, 1, mesh('new'));
    adopt([render('new')]);
    expect(viewer.getShapeTransparency('new')).toBe(0.3);
    expect(meshes[0].material.opacity).toBe(0.3);
    expect(meshes[0].material.transparent).toBe(true);

    viewer.resetAllTransparency();
    expect(viewer.getShapeTransparency('new')).toBe(1);
    expect(meshes[0].material.opacity).toBe(1);
    expect(meshes[0].material.transparent).toBe(false);
  });
});
