import { SceneObjectRender, SourceLocation } from '../types';

export function isTopLevel(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  if (!obj.parentId) {
    return true;
  }
  const parent = sceneObjects.find(o => o.id === obj.parentId);
  return parent?.type === 'part';
}

/**
 * The timeline's active part, injected by main.ts from the ActivePartTracker.
 * The tracker re-syncs against every render before the scope helpers below
 * run (see the scene-rendered handler), so matching its location by exact
 * file + line is safe — a shifted or renamed part row has already been
 * re-adopted.
 */
let activePartLocationProvider: () => SourceLocation | null = () => null;

export function setActivePartLocationProvider(provider: () => SourceLocation | null): void {
  activePartLocationProvider = provider;
}

/** The part row the timeline's active part resolves to in this scene, if any. */
export function findActivePart(sceneObjects: SceneObjectRender[]): SceneObjectRender | undefined {
  const loc = activePartLocationProvider();
  if (!loc) {
    return undefined;
  }
  return sceneObjects.find(o => o.type === 'part' && !o.parentId
    && o.sourceLocation?.filePath === loc.filePath && o.sourceLocation?.line === loc.line);
}

/**
 * The rows of the active scope, in scene order: the active part's direct
 * children while a part is active, else every top-level row. New statements
 * land at the end of this scope, so its tail is "where the user is working".
 */
export function activeScopeObjects(sceneObjects: SceneObjectRender[]): SceneObjectRender[] {
  const part = findActivePart(sceneObjects);
  if (part) {
    return sceneObjects.filter(o => o.parentId === part.id);
  }
  return sceneObjects.filter(o => isTopLevel(o, sceneObjects));
}

/**
 * The "active" feature — the last object of the active scope. With a part
 * active this is that part's last feature (an empty part has none), NOT the
 * scene's last object: another part further down may keep building, but the
 * user is editing here. Returned regardless of visibility so a non-sketch
 * tip with no shapes doesn't fall through to an earlier sketch and wrongly
 * enter sketch mode.
 */
export function findActiveObject(sceneObjects: SceneObjectRender[]): SceneObjectRender | undefined {
  const scope = activeScopeObjects(sceneObjects);
  return scope.length > 0 ? scope[scope.length - 1] : undefined;
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
