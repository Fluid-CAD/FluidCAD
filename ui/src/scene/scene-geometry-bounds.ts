import { Box3, Object3D } from 'three';

/**
 * Where the viewer's modelled geometry lives depends on the mode. A part
 * render builds one `compiledMesh` group; an assembly render removes that
 * mesh and mounts the AssemblyController's container instead (instance
 * groups posed by the solver, connectors, provisional replicas). Anything
 * that measures "the scene" — fit-to-view, the centroid indicator radius,
 * standard-plane sizing — has to look at whichever root is mounted, or it
 * silently sees nothing in assembly mode.
 */
export const COMPILED_MESH_NAME = 'compiledMesh';

/** Recursively expand `box` to include `object`, skipping meta-shape subtrees. */
export function expandBoxExcludingMeta(box: Box3, object: Object3D): void {
  for (const part of collectParts(object, [])) {
    box.union(part);
  }
}

/** Every drawn piece under `object` as its own world-space box, meta shapes skipped. */
function collectParts(object: Object3D, into: Box3[]): Box3[] {
  if (object.userData.isMetaShape) return into;
  const o = object as any;
  if ((o.isMesh || o.isLine || o.isPoints) && o.geometry) {
    o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox) {
      into.push(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  }
  for (const child of object.children) {
    collectParts(child, into);
  }
  return into;
}

/**
 * World-space bounds of everything under `root`, meta shapes excluded.
 *
 * The world matrices are refreshed first, and that is the whole point of this
 * function existing next to {@link expandBoxExcludingMeta}: a caller measuring
 * geometry in the same tick that built or moved it — an assembly render, which
 * runs the mate solver and re-poses every instance group before returning — is
 * otherwise reading matrices from before the move, and framing a model that
 * was never on screen.
 */
export function geometryBoundsOf(root: Object3D): Box3 {
  return unionBox(geometryPartsOf(root));
}

/** The one box around a set of them. Empty when the set is. */
export function unionBox(parts: readonly Box3[]): Box3 {
  const box = new Box3();
  for (const part of parts) {
    box.union(part);
  }
  return box;
}

/**
 * The same geometry, left as the pieces it is made of rather than unioned
 * into one box. A fit that frames the scene tightly wants these: the space
 * an engine's parts cover between them is a good deal smaller — and sits
 * somewhere else — than the box drawn around the lot.
 */
export function geometryPartsOf(root: Object3D): Box3[] {
  root.updateWorldMatrix(true, true);
  return collectParts(root, []);
}

/**
 * The object holding the current render's geometry: the assembly container
 * while it is mounted in `scene`, otherwise the compiled part mesh. Null when
 * neither is present (nothing rendered yet).
 */
export function findGeometryRoot(scene: Object3D, assemblyContainer: Object3D | null): Object3D | null {
  if (assemblyContainer && assemblyContainer.parent) {
    return assemblyContainer;
  }
  return scene.getObjectByName(COMPILED_MESH_NAME) ?? null;
}

/**
 * World-space bounds of the modelled geometry (meta shapes excluded), or
 * null when there is no geometry to measure.
 */
export function sceneGeometryBounds(scene: Object3D, assemblyContainer: Object3D | null): Box3 | null {
  const root = findGeometryRoot(scene, assemblyContainer);
  if (!root) {
    return null;
  }
  const box = geometryBoundsOf(root);
  return box.isEmpty() ? null : box;
}
