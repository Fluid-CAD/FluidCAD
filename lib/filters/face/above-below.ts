import { Matrix4 } from "../../math/matrix4.js";
import { Plane } from "../../math/plane.js";
import { Face } from "../../common/shapes.js";
import { SceneObject } from "../../common/scene-object.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneRefSource, comparePlaneRefs, planeRefSceneObject, resolvePlaneRef } from "../plane-ref.js";

function getBoundaryPoints(face: Face) {
  return face.getEdges().flatMap(edge => [
    EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(edge)),
    EdgeOps.getVertexPoint(EdgeOps.getLastVertex(edge)),
  ]);
}

/**
 * Half-space test shared by the face `above`/`below` filters. The reference
 * follows the edge filters' contract: a plane, a plane feature, or a scene
 * object whose first shape is a face, resolved lazily; the offset is applied
 * along the resolved normal at match time.
 */
abstract class HalfSpaceFaceFilter extends FilterBase<Face> {
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

  match(shape: Face): boolean {
    const plane = this.resolvedPlane();
    const flags = getBoundaryPoints(shape).map(p => this.onSide(plane.signedDistanceToPoint(p)));
    if (flags.length === 0) {
      return false;
    }
    return this.partial ? flags.some(Boolean) : flags.every(Boolean);
  }

  compareTo(other: HalfSpaceFaceFilter): boolean {
    return comparePlaneRefs(this.plane, other.plane)
      && this.partial === other.partial
      && this.offset === other.offset;
  }

  override getSceneObjectRefs(): SceneObject[] {
    const source = planeRefSceneObject(this.plane);
    return source ? [source] : [];
  }
}

export class AboveFacePlaneFilter extends HalfSpaceFaceFilter {
  protected onSide(distance: number): boolean {
    return distance > 0;
  }

  transform(matrix: Matrix4): AboveFacePlaneFilter {
    return new AboveFacePlaneFilter(new PlaneObject(this.resolvedPlane().applyMatrix(matrix)), this.partial);
  }

  override remap(remap: Map<SceneObject, SceneObject>): AboveFacePlaneFilter {
    const source = planeRefSceneObject(this.plane);
    const remapped = source ? remap.get(source) : undefined;
    return remapped ? new AboveFacePlaneFilter(remapped, this.partial, this.offset) : this;
  }
}

export class BelowFacePlaneFilter extends HalfSpaceFaceFilter {
  protected onSide(distance: number): boolean {
    return distance < 0;
  }

  transform(matrix: Matrix4): BelowFacePlaneFilter {
    return new BelowFacePlaneFilter(new PlaneObject(this.resolvedPlane().applyMatrix(matrix)), this.partial);
  }

  override remap(remap: Map<SceneObject, SceneObject>): BelowFacePlaneFilter {
    const source = planeRefSceneObject(this.plane);
    const remapped = source ? remap.get(source) : undefined;
    return remapped ? new BelowFacePlaneFilter(remapped, this.partial, this.offset) : this;
  }
}
