import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Edge } from "../../common/shapes.js";
import { SceneObject } from "../../common/scene-object.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneRefSource, comparePlaneRefs, planeRefSceneObject, resolvePlaneRef } from "../plane-ref.js";

/**
 * Half-space test shared by `above`/`below`: the reference is a plane, a plane
 * feature, or any scene object whose first shape is a face (a bucket accessor
 * like `base.endFaces()`), resolved lazily like `onPlane`'s reference. The
 * offset is applied along the resolved plane's normal at match time, so a
 * reference plane that moves with a dimension edit keeps the offset relative.
 */
abstract class HalfSpaceEdgeFilter extends FilterBase<Edge> {
  constructor(
    protected plane: PlaneRefSource,
    protected partial: boolean = false,
    protected offset: number = 0,
  ) {
    super();
  }

  protected resolvedPlane(): Plane {
    const plane = resolvePlaneRef(this.plane);
    return this.offset ? plane.offset(this.offset) : plane;
  }

  protected abstract onSide(distance: number): boolean;

  match(shape: Edge): boolean {
    const plane = this.resolvedPlane();
    const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
    const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
    const first = this.onSide(plane.signedDistanceToPoint(firstPoint));
    const last = this.onSide(plane.signedDistanceToPoint(lastPoint));
    if (this.partial) {
      return first || last;
    }
    return first && last;
  }

  compareTo(other: HalfSpaceEdgeFilter): boolean {
    return comparePlaneRefs(this.plane, other.plane)
      && this.partial === other.partial
      && this.offset === other.offset;
  }

  override getSceneObjectRefs(): SceneObject[] {
    const source = planeRefSceneObject(this.plane);
    return source ? [source] : [];
  }
}

export class AbovePlaneFilter extends HalfSpaceEdgeFilter {
  protected onSide(distance: number): boolean {
    return distance > 0;
  }

  transform(matrix: Matrix4): AbovePlaneFilter {
    return new AbovePlaneFilter(new PlaneObject(this.resolvedPlane().applyMatrix(matrix)), this.partial);
  }

  override remap(remap: Map<SceneObject, SceneObject>): AbovePlaneFilter {
    const source = planeRefSceneObject(this.plane);
    const remapped = source ? remap.get(source) : undefined;
    return remapped ? new AbovePlaneFilter(remapped, this.partial, this.offset) : this;
  }
}

export class BelowPlaneFilter extends HalfSpaceEdgeFilter {
  protected onSide(distance: number): boolean {
    return distance < 0;
  }

  transform(matrix: Matrix4): BelowPlaneFilter {
    return new BelowPlaneFilter(new PlaneObject(this.resolvedPlane().applyMatrix(matrix)), this.partial);
  }

  override remap(remap: Map<SceneObject, SceneObject>): BelowPlaneFilter {
    const source = planeRefSceneObject(this.plane);
    const remapped = source ? remap.get(source) : undefined;
    return remapped ? new BelowPlaneFilter(remapped, this.partial, this.offset) : this;
  }
}
