import { SceneObject } from "../common/scene-object.js";
import { Face } from "../common/face.js";
import { Plane } from "../math/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { withUnit } from "../units/registry.js";

/**
 * What an `onPlane`/`notOnPlane` filter accepts beyond a raw plane: a plane
 * feature, or any scene object whose first shape is a face — a bucket
 * accessor like `e.endFaces()`, or a select(). The face is only *read* to
 * derive its plane, exactly like `plane(selection)`, but without creating a
 * plane feature in the scene: the reference is internal to the filter, so
 * nothing renders and nothing needs consuming.
 */
export type PlaneRefSource = PlaneObjectBase | SceneObject;

/**
 * Resolve the reference to a concrete plane. A bare accessor passed straight
 * into a filter is lazy and lives outside the scene, so the render pipeline
 * never builds it — resolve it here on demand (its producer precedes the
 * consuming statement, so the recorded bucket state is already in place).
 * The face-extraction contract mirrors `PlaneFromObject.getFromSceneObject`:
 * the first resolved shape must be a face, whose surface plane is returned.
 */
export function resolvePlaneRef(source: PlaneRefSource): Plane {
  if (source instanceof PlaneObjectBase) {
    return source.getPlane();
  }
  let shapes = source.getShapes();
  if (shapes.length === 0 && source.isLazy()) {
    withUnit(source.getUnit(), () => source.build());
    shapes = source.getShapes();
  }
  if (shapes.length === 0) {
    throw new Error("onPlane: the selection resolved no shapes to take a plane from");
  }
  const face = shapes[0];
  if (!face.isFace()) {
    throw new Error(`onPlane: the selected shape is not a face; cannot extract a plane: ${face.getType()}`);
  }
  return (face as Face).getPlane();
}

/** Structural equality between two plane references (scene-compare reuse). */
export function comparePlaneRefs(a: PlaneRefSource, b: PlaneRefSource): boolean {
  return a.compareTo(b as never);
}

/** The reference's scene-object dependency, when it has one. */
export function planeRefSceneObject(source: PlaneRefSource): SceneObject | null {
  return source instanceof PlaneObjectBase ? null : source;
}
