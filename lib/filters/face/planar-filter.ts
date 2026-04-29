import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";

export class PlanarFilter extends FilterBase<Face> {
  constructor() {
    super();
  }

  match(shape: Face): boolean {
    return FaceQuery.isPlanarFace(shape);
  }

  compareTo(other: PlanarFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): PlanarFilter {
    return new PlanarFilter();
  }
}

export class NotPlanarFilter extends FilterBase<Face> {
  constructor() {
    super();
  }

  match(shape: Face): boolean {
    return !FaceQuery.isPlanarFace(shape);
  }

  compareTo(other: NotPlanarFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotPlanarFilter {
    return new NotPlanarFilter();
  }
}
