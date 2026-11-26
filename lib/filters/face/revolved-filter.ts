import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";

/** A face on a surface of revolution that is no plane, cylinder, cone, sphere or torus; see {@link SurfaceClassifier}. */
export class RevolvedFilter extends FilterBase<Face> {
  match(shape: Face): boolean {
    return SurfaceClassifier.classify(shape).kind === 'revolved';
  }

  compareTo(other: RevolvedFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): RevolvedFilter {
    return new RevolvedFilter();
  }
}

export class NotRevolvedFilter extends FilterBase<Face> {
  match(shape: Face): boolean {
    return SurfaceClassifier.classify(shape).kind !== 'revolved';
  }

  compareTo(other: NotRevolvedFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotRevolvedFilter {
    return new NotRevolvedFilter();
  }
}
