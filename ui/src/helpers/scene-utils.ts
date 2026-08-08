import { SceneObjectRender } from '../types';

export function isTopLevel(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  if (!obj.parentId) {
    return true;
  }
  const parent = sceneObjects.find(o => o.id === obj.parentId);
  return parent?.type === 'part';
}

/** The object carries real material: a solid, not a meta or guide shape. */
function hasSolidShape(obj: SceneObjectRender): boolean {
  return obj.sceneShapes?.some(s => s.shapeType === 'solid' && !s.isMetaShape && !s.isGuide) === true;
}

/**
 * Nothing in the render is material a feature could be built *from* — no
 * solids and no sketches. Everything else a document can hold at this point is
 * a construction input: planes, axes, a `select()` overlay, or a helix (a
 * wire — you sweep a profile along it, you can't build it into anything on its
 * own). Those leave the scene as empty as a blank file, so the toolbar treats
 * them the same. See {@link Viewer.sceneIsEmpty}.
 */
export function isSceneEmpty(sceneObjects: SceneObjectRender[]): boolean {
  return !sceneObjects.some(o => o.type === 'sketch' || hasSolidShape(o));
}
