import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";

/** A face on a surface of linear extrusion that is no plane or cylinder; see {@link SurfaceClassifier}. */
export class ExtrudedFilter extends FilterBase<Face> {
  match(shape: Face): boolean {
    return SurfaceClassifier.classify(shape).kind === 'extruded';
  }

  compareTo(other: ExtrudedFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): ExtrudedFilter {
    return new ExtrudedFilter();
  }
}

export class NotExtrudedFilter extends FilterBase<Face> {
  match(shape: Face): boolean {
    return SurfaceClassifier.classify(shape).kind !== 'extruded';
  }

  compareTo(other: NotExtrudedFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotExtrudedFilter {
    return new NotExtrudedFilter();
  }
}
