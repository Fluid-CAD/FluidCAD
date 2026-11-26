import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";

/** A face on a free-form surface: no elementary surface, surface of revolution or of extrusion stands for it; see {@link SurfaceClassifier}. */
export class FreeformFilter extends FilterBase<Face> {
  match(shape: Face): boolean {
    return SurfaceClassifier.classify(shape).kind === 'freeform';
  }

  compareTo(other: FreeformFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): FreeformFilter {
    return new FreeformFilter();
  }
}

export class NotFreeformFilter extends FilterBase<Face> {
  match(shape: Face): boolean {
    return SurfaceClassifier.classify(shape).kind !== 'freeform';
  }

  compareTo(other: NotFreeformFilter): boolean {
    return true;
  }

  transform(matrix: Matrix4): NotFreeformFilter {
    return new NotFreeformFilter();
  }
}
