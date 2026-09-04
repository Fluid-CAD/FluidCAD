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
  if (object.userData.isMetaShape) return;
  const o = object as any;
  if ((o.isMesh || o.isLine || o.isPoints) && o.geometry) {
    o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox) {
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  }
  for (const child of object.children) {
    expandBoxExcludingMeta(box, child);
  }
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
  root.updateWorldMatrix(true, true);
  const box = new Box3();
  expandBoxExcludingMeta(box, root);
  return box.isEmpty() ? null : box;
}
