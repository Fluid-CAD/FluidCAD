import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { SceneObject } from "../../common/scene-object.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneRefSource, comparePlaneRefs, planeRefSceneObject, resolvePlaneRef } from "../plane-ref.js";

export class OnPlaneFilter extends FilterBase<Face> {
  constructor(private plane: PlaneRefSource) {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isFaceOnPlane(shape, resolvePlaneRef(this.plane));
  }

  compareTo(other: OnPlaneFilter): boolean {
    return comparePlaneRefs(this.plane, other.plane);
  }

  transform(matrix: Matrix4): OnPlaneFilter {
    const plane = resolvePlaneRef(this.plane);
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new OnPlaneFilter(planeObj);
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
    return remapped ? new OnPlaneFilter(remapped) : this;
  }
}

export class NotOnPlaneFilter extends FilterBase<Face> {
  constructor(private plane: PlaneRefSource) {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isFaceOnPlane(shape, resolvePlaneRef(this.plane));
  }

  compareTo(other: NotOnPlaneFilter): boolean {
    return comparePlaneRefs(this.plane, other.plane);
  }

  transform(matrix: Matrix4): NotOnPlaneFilter {
    const plane = resolvePlaneRef(this.plane);
    const planeObj = new PlaneObject(plane.applyMatrix(matrix));
    return new NotOnPlaneFilter(planeObj);
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
    return remapped ? new NotOnPlaneFilter(remapped) : this;
  }
}
