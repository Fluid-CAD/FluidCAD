import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { TransformablePrimitive } from "../common/transformable-primitive.js";

/**
 * A clone-only stand-in for sketch geometry that a repeated feature references
 * but that lives in a sketch *outside* the cloned set — e.g. a `sweep` whose
 * path is `otherSketch.regions.foo`.
 *
 * Such geometry cannot be rebuilt during the clone: a 2D curve resolves its
 * plane by walking up to its owning `Sketch` (see GeometrySceneObject.sketch),
 * and its pen position depends on sibling curves that are not part of the
 * clone. Cloning it out of its sketch leaves it parented under the repeat
 * container with no sketch ancestor, so `this.sketch` is `null` and build
 * throws "Cannot read properties of null (reading 'getPlane')".
 *
 * Instead we freeze the source's already-built edges (which are final,
 * world-space, and already incorporate any fillet/trim) and bake in the
 * per-instance clone transform — exactly like cloned primitives
 * (cylinder/sphere) do via {@link TransformablePrimitive.addPrimitiveShape}.
 */
export class FrozenGeometry extends TransformablePrimitive {
  constructor(private source: SceneObject) {
    super();
  }

  build(context?: BuildSceneObjectContext) {
    // Read the source's raw built edges rather than getShapes(): the original
    // feature that consumes this geometry (e.g. the un-cloned sweep) may have
    // marked it removed via removeShapes(), which getShapes() filters out. The
    // edges themselves are unchanged, so we still want them — skipping only
    // meta/guide shapes, matching how a spine/region is normally read.
    for (const shape of this.source.getAddedShapes()) {
      if (shape.isMetaShape() || shape.isGuideShape()) {
        continue;
      }
      this.addPrimitiveShape(shape, context);
    }
  }

  override getDependencies(): SceneObject[] {
    // The source is the pre-existing original, not part of the clone set; it is
    // built earlier in the scene order, so we read its shapes at build time
    // rather than depending on a clone of it.
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new FrozenGeometry(this.source).syncPrimitiveWith(this);
  }

  compareTo(other: SceneObject): boolean {
    if (!(other instanceof FrozenGeometry)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.source.compareTo(other.source);
  }

  getType(): string {
    return "frozen-geometry";
  }

  serialize() {
    return {};
  }
}
