import { Camera, Group, Object3D } from 'three';
import { MeshRenderOptions, SceneObjectRender } from '../types';
import { SketchMesh } from './containers/sketch-mesh';
import { PlaneMesh } from './containers/plane-mesh';
import { AxisMesh } from './containers/axis-mesh';
import { ShapeGroup } from './containers/shape-group';

// ---------------------------------------------------------------------------
// Preset render options for special object types
// ---------------------------------------------------------------------------

const SELECT_OPTIONS: MeshRenderOptions = {
  edge: { color: '#11a4ed', lineWidth: 3, depthWrite: false },
  face: { color: '#5c9fcc', opacity: 1 },
};

const SKETCH_TRANSPARENT_OPTIONS: MeshRenderOptions = {
  edge: { opacity: 0.3 },
  face: { opacity: 0.3 },
};

// ---------------------------------------------------------------------------
// Option resolution
// ---------------------------------------------------------------------------

/**
 * Determine the render options for a given object.  Priority:
 *  1. Inherited options from a parent (e.g. a `select` ancestor).
 *  2. Per-type overrides (`select` → selection highlight colours).
 *  3. Mode-based overrides (sketch mode → ghost non-sketch objects).
 */
function resolveOptions(
  uniqueType: string | undefined,
  activeSketchId: string | null,
  type: string | undefined,
  inherited?: MeshRenderOptions,
): MeshRenderOptions | undefined {
  if (inherited) return inherited;
  if (uniqueType === 'select') return SELECT_OPTIONS;
  if (activeSketchId && type !== 'sketch') return SKETCH_TRANSPARENT_OPTIONS;
  return undefined;
}

// ---------------------------------------------------------------------------
// Public factory functions
// ---------------------------------------------------------------------------

/**
 * Build the Three.js object tree for a single `SceneObjectRender`.
 *
 * Objects with dedicated visual representations (sketch, plane, axis) are
 * routed to their specialised mesh classes.  Everything else is handled by
 * `ShapeGroup` which converts the raw shape data into faces / edges / solids.
 *
 * Child objects are resolved recursively so the entire sub-tree is built in
 * one call.
 */
export function buildObjectMesh(
  obj: SceneObjectRender,
  allObjects: SceneObjectRender[],
  activeSketchId: string | null,
  camera: Camera,
  isRegionPicking: boolean,
  inherited?: MeshRenderOptions,
): Object3D {
  // --- dedicated mesh classes for construction geometry ---
  switch (obj.type) {
    case 'sketch':
      return new SketchMesh(obj, allObjects, activeSketchId, camera);
    case 'plane':
      return new PlaneMesh(obj, camera);
    case 'axis':
      return new AxisMesh(obj);
  }

  // --- generic objects: resolve options and recurse into children ---
  const isSelect = obj.uniqueType === 'select';
  const options = resolveOptions(obj.uniqueType, activeSketchId, obj.type, inherited);
  const children = allObjects.filter(o => o.parentId === obj.id);

  let result: Object3D;

  if (children.length > 0) {
    const group = new Group();
    for (const child of children) {
      group.add(buildObjectMesh(child, allObjects, activeSketchId, camera, isRegionPicking, options));
    }
    result = group;
  } else {
    // Leaf node — build geometry from shape data
    result = new ShapeGroup(obj, isRegionPicking, options);
  }

  // Select overlays render last so they always appear on top.
  if (isSelect) {
    result.traverse(child => { child.renderOrder = 999; });
  }

  return result;
}

/**
 * Build the top-level scene container holding all visible root objects.
 */
export function buildSceneMesh(
  sceneObjects: SceneObjectRender[],
  activeSketchId: string | null,
  camera: Camera,
  isRegionPicking: boolean = false,
): Object3D {
  const container = new Group();
  container.name = 'compiledMesh';

  for (const obj of sceneObjects) {
    if (obj.parentId) continue;
    if (!obj.visible && !(activeSketchId && obj.type === 'sketch')) continue;
    container.add(buildObjectMesh(obj, sceneObjects, activeSketchId, camera, isRegionPicking));
  }

  return container;
}
