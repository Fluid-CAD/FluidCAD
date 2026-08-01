// The signal behind the blank-document toolbar: with nothing modelled, every
// feature service ORs `Viewer.sceneIsEmpty` into its own availability rule so
// the bar shows all of its buttons instead of just Import / Sketch / Plane.
import { describe, it, expect } from 'vitest';
import { isSceneEmpty } from '../src/helpers/scene-utils';
import type { SceneObjectPart, SceneObjectRender } from '../src/types';

function row(type: string, shapes: Partial<SceneObjectPart>[] = []): SceneObjectRender {
  return { id: `${type}-1`, name: type, type, sceneShapes: shapes, ownShapes: shapes } as SceneObjectRender;
}

const SOLID: Partial<SceneObjectPart> = { shapeType: 'solid' };

describe('isSceneEmpty', () => {
  it('treats a scene with no objects at all as empty', () => {
    expect(isSceneEmpty([])).toBe(true);
  });

  it('treats construction-only documents as empty', () => {
    // Declaring a plane or an axis models nothing — the toolbar must not
    // collapse back to three buttons the moment one is created.
    expect(isSceneEmpty([row('plane'), row('axis'), row('select')])).toBe(true);
  });

  it('treats a helix as construction geometry', () => {
    // A helix is a wire: you sweep a profile along it, so on its own there is
    // still nothing to build from (and Sweep has to stay reachable to use it).
    expect(isSceneEmpty([row('helix', [{ shapeType: 'edge' }])])).toBe(true);
    expect(isSceneEmpty([row('axis'), row('helix', [{ shapeType: 'edge' }])])).toBe(true);
  });

  it('is not empty once a sketch exists', () => {
    expect(isSceneEmpty([row('plane'), row('sketch')])).toBe(false);
  });

  it('is not empty once a solid is modelled', () => {
    expect(isSceneEmpty([row('extrude', [SOLID])])).toBe(false);
    expect(isSceneEmpty([row('helix', [{ shapeType: 'edge' }]), row('pipe', [SOLID])])).toBe(false);
  });

  it('ignores meta and guide shapes', () => {
    // Trim regions and preview guides are overlays, not modelled material.
    expect(isSceneEmpty([row('box', [{ shapeType: 'solid', isMetaShape: true }])])).toBe(true);
    expect(isSceneEmpty([row('box', [{ shapeType: 'solid', isGuide: true }])])).toBe(true);
  });
});
