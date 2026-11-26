import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";
import { DirectionLike, compareDirections, resolveDirection, transformDirection } from "../direction.js";

/**
 * Whether the face faces within `within` degrees of `direction`: the angle
 * is taken from the face's mean outward normal (see
 * {@link FaceQuery.meanNormal}). A face that faces nowhere — a bore, a boss
 * wall, a whole sphere — faces no direction, whatever the angle.
 */
function isFacing(face: Face, direction: DirectionLike, within: number): boolean {
  const normal = FaceQuery.meanNormal(face);
  if (!normal) {
    return false;
  }
  const cosine = normal.dot(resolveDirection(direction));
  // unit: dimensionless (cosine), absorbs rounding at exactly `within` degrees
  return cosine >= Math.cos((within * Math.PI) / 180) - 1e-12;
}

export class FacingFilter extends FilterBase<Face> {
  constructor(private direction: DirectionLike, private within: number) {
    super();
  }

  match(shape: Face): boolean {
    return isFacing(shape, this.direction, this.within);
  }

  compareTo(other: FacingFilter): boolean {
    return this.within === other.within && compareDirections(this.direction, other.direction);
  }

  transform(matrix: Matrix4): FacingFilter {
    return new FacingFilter(transformDirection(this.direction, matrix), this.within);
  }
}

/** The complement of {@link FacingFilter}: it keeps a face that faces nowhere. */
export class NotFacingFilter extends FilterBase<Face> {
  constructor(private direction: DirectionLike, private within: number) {
    super();
  }

  match(shape: Face): boolean {
    return !isFacing(shape, this.direction, this.within);
  }

  compareTo(other: NotFacingFilter): boolean {
    return this.within === other.within && compareDirections(this.direction, other.direction);
  }

  transform(matrix: Matrix4): NotFacingFilter {
    return new NotFacingFilter(transformDirection(this.direction, matrix), this.within);
  }
}
