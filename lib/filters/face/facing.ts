import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FaceQuery } from "../../oc/face-query.js";
import { DirectionLike, compareDirections, resolveDirection, transformDirection } from "../direction.js";

/**
 * Whether the face's outward normal at its UV centre lies within `within`
 * degrees of `direction`. A face whose normal is undefined there (a
 * degenerate apex) faces nowhere.
 */
function isFacing(face: Face, direction: DirectionLike, within: number): boolean {
  const normal = FaceQuery.centreNormal(face);
  if (!normal) {
    return false;
  }
  const cosine = normal.normalize().dot(resolveDirection(direction));
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
