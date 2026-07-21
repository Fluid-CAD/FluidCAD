import { Matrix4 } from "../math/matrix4.js";
import { LazyMatrix } from "../math/lazy-matrix.js";
import { SceneObject } from "../common/scene-object.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Sketch } from "../features/2d/sketch.js";
import { FrozenGeometry } from "../features/frozen-geometry.js";

export function cloneWithTransform(
  objects: SceneObject[],
  transform: Matrix4 | LazyMatrix,
  container: SceneObject
): SceneObject[] {
  const visited = new Set<SceneObject>();
  const ordered: SceneObject[] = [];

  const collectDeps = (obj: SceneObject) => {
    if (visited.has(obj)) {
      return;
    }
    visited.add(obj);

    for (const dep of obj.getDependencies()) {
      collectDeps(dep);
    }

    ordered.push(obj);

    // Collect children without following their dependencies —
    // cloned children will reference originals for any deps not in the clone set
    collectChildren(obj);
  };

  const collectChildren = (obj: SceneObject) => {
    for (const child of obj.getChildren()) {
      if (visited.has(child)) {
        continue;
      }
      visited.add(child);
      ordered.push(child);
      collectChildren(child);
    }
  };

  for (const obj of objects) {
    collectDeps(obj);
  }

  // Sketch geometry whose owning sketch is part of the clone set rebuilds
  // normally (on the cloned, transformed plane). But a repeated feature can
  // also reference a bare curve that lives in a sketch *outside* the clone set
  // (e.g. a sweep path `otherSketch.regions.foo`). That curve has no sketch
  // ancestor among the clones, so it can't rebuild — `this.sketch` would be
  // null. Freeze such geometry's built edges instead (see FrozenGeometry).
  const clonedSketches = new Set<SceneObject>();
  for (const obj of ordered) {
    if (obj instanceof Sketch) {
      clonedSketches.add(obj);
    }
  }
  const owningSketchInCloneSet = (geom: SceneObject): boolean => {
    let parent = geom.getParent();
    while (parent && !(parent instanceof Sketch)) {
      parent = parent.getParent();
    }
    return parent ? clonedSketches.has(parent) : false;
  };
  const isOrphanGeometry = (obj: SceneObject): boolean =>
    obj instanceof GeometrySceneObject && !owningSketchInCloneSet(obj);

  // A boundary orphan is one a kept (non-orphan) clone — or a repeat root —
  // actually references. Those get frozen; orphan geometry reachable only as
  // the source curves of another orphan (e.g. the lines behind a fillet) is
  // dropped, since the frozen edges already incorporate it.
  const roots = new Set(objects);
  const frozenSources = new Set<SceneObject>();
  for (const obj of ordered) {
    if (isOrphanGeometry(obj)) {
      if (roots.has(obj)) {
        frozenSources.add(obj);
      }
      continue;
    }
    for (const dep of obj.getDependencies()) {
      if (isOrphanGeometry(dep)) {
        frozenSources.add(dep);
      }
    }
  }

  const remap = new Map<SceneObject, SceneObject>();
  const allCloned: SceneObject[] = [];

  const registerClone = (source: SceneObject, copy: SceneObject) => {
    remap.set(source, copy);
    copy.setTransform(transform);
    copy.setCloneSource(source);
    if (source.isReusable()) {
      copy.reusable();
    }
    allCloned.push(copy);
  };

  // Freeze boundary orphans first so referring clones remap onto them. They
  // hold baked edges and need no sketch parent, so they live under the
  // container directly.
  for (const source of frozenSources) {
    const frozen = new FrozenGeometry(source);
    registerClone(source, frozen);
    container.addChildObject(frozen);
  }

  for (const obj of ordered) {
    if (isOrphanGeometry(obj)) {
      // Frozen above, or dropped as the source of a frozen curve.
      continue;
    }

    const copy = obj.createCopy(remap);
    registerClone(obj, copy);

    const parent = obj.getParent();
    if (parent && remap.has(parent)) {
      remap.get(parent)!.addChildObject(copy);
    } else if (!copy.parentId) {
      container.addChildObject(copy);
    }
  }

  return allCloned;
}
