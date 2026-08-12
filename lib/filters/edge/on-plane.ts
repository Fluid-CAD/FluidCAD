import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { SceneObject } from "../../common/scene-object.js";
import { FilterBase } from "../filter-base.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneRefSource, comparePlaneRefs, planeRefSceneObject, resolvePlaneRef } from "../plane-ref.js";

export class OnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneRefSource, private plane2?: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = resolvePlaneRef(this.plane);
    if (this.partial) {
      const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
      const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
      if (plane.containsPoint(firstPoint) || plane.containsPoint(lastPoint)) {
        return true;
      }
      if (this.plane2) {
        const plane2 = this.plane2.getPlane();
        return plane2.containsPoint(firstPoint) || plane2.containsPoint(lastPoint);
      }
      return false;
    }
    if (EdgeQuery.isEdgeOnPlane(shape, plane)) {
      return true;
    }
    if (this.plane2) {
      return EdgeQuery.isEdgeOnPlane(shape, this.plane2.getPlane());
    }
    return false;
  }

  compareTo(other: OnPlaneFilter): boolean {
    if (!comparePlaneRefs(this.plane, other.plane) || this.partial !== other.partial) {
      return false;
    }
    if (this.plane2 && other.plane2) {
      return this.plane2.compareTo(other.plane2);
    }
    return this.plane2 === other.plane2;
  }

  transform(matrix: Matrix4): OnPlaneFilter {
    const transformedPlane = resolvePlaneRef(this.plane).applyMatrix(matrix);
    const planeObj2 = this.plane2 ? new PlaneObject(this.plane2.getPlane().applyMatrix(matrix)) : undefined;
    return new OnPlaneFilter(new PlaneObject(transformedPlane), planeObj2, this.partial);
  }

  override getSceneObjectRefs(): SceneObject[] {
    const source = planeRefSceneObject(this.plane);
    return source ? [source] : [];
  }

  override remap(remap: Map<SceneObject, SceneObject>): OnPlaneFilter {
    const source = planeRefSceneObject(this.plane);
    if (!source) {
      return this;
    }
    const remapped = remap.get(source);
    return remapped ? new OnPlaneFilter(remapped, this.plane2, this.partial) : this;
  }
}

export class NotOnPlaneFilter extends FilterBase<Edge> {
  constructor(private plane: PlaneRefSource, private plane2?: PlaneObjectBase, private partial: boolean = false) {
    super();
  }

  match(shape: Edge): boolean {
    const plane = resolvePlaneRef(this.plane);
    if (this.partial) {
      const firstPoint = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(shape));
      const lastPoint = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(shape));
      if (plane.containsPoint(firstPoint) || plane.containsPoint(lastPoint)) {
        return false;
      }
      if (this.plane2) {
        const plane2 = this.plane2.getPlane();
        return !plane2.containsPoint(firstPoint) && !plane2.containsPoint(lastPoint);
      }
      return true;
    }
    if (this.plane2) {
      return !EdgeQuery.isEdgeOnPlane(shape, plane) && !EdgeQuery.isEdgeOnPlane(shape, this.plane2.getPlane());
    }
    return !EdgeQuery.isEdgeOnPlane(shape, plane);
  }

  compareTo(other: NotOnPlaneFilter): boolean {
    if (!comparePlaneRefs(this.plane, other.plane) || this.partial !== other.partial) {
      return false;
    }
    if (this.plane2 && other.plane2) {
      return this.plane2.compareTo(other.plane2);
    }
    return this.plane2 === other.plane2;
  }

  transform(matrix: Matrix4): NotOnPlaneFilter {
    const transformedPlane = resolvePlaneRef(this.plane).applyMatrix(matrix);
    const planeObj2 = this.plane2 ? new PlaneObject(this.plane2.getPlane().applyMatrix(matrix)) : undefined;
    return new NotOnPlaneFilter(new PlaneObject(transformedPlane), planeObj2, this.partial);
  }

  override getSceneObjectRefs(): SceneObject[] {
    const source = planeRefSceneObject(this.plane);
    return source ? [source] : [];
  }

  override remap(remap: Map<SceneObject, SceneObject>): NotOnPlaneFilter {
    const source = planeRefSceneObject(this.plane);
    if (!source) {
      return this;
    }
    const remapped = remap.get(source);
    return remapped ? new NotOnPlaneFilter(remapped, this.plane2, this.partial) : this;
  }
}
