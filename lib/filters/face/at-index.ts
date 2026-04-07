import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Point } from "../../math/point.js";

export class AtIndexFilter extends FilterBase<Face> {
  constructor(private index: number, private shapes: Face[], private originalShapes?: Face[]) {
    super();
  }

  match(shape: Face): boolean {
    return this.shapes[this.index] === shape;
  }

  compareTo(other: AtIndexFilter): boolean {
    if (this.index !== other.index) {
      return false;
    }

    if (this.shapes.length !== other.shapes.length) {
      return false;
    }

    return true;
  }

  transform(matrix: Matrix4): AtIndexFilter {
    if (matrix.isMirroring() && this.originalShapes) {
      const source = this.originalShapes[this.index];
      const bbox = ShapeOps.getBoundingBox(source);
      const originalCenter = new Point(bbox.centerX, bbox.centerY, bbox.centerZ);
      const targetCenter = matrix.transformPoint(originalCenter);

      let bestIndex = this.index;
      let bestDist = Infinity;
      for (let i = 0; i < this.shapes.length; i++) {
        const b = ShapeOps.getBoundingBox(this.shapes[i]);
        const dist = new Point(b.centerX, b.centerY, b.centerZ).distanceTo(targetCenter);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }

      return new AtIndexFilter(bestIndex, this.shapes);
    }

    return new AtIndexFilter(this.index, this.shapes);
  }
}

export class NotAtIndexFilter extends FilterBase<Face> {
  constructor(private index: number, private shapes: Face[], private originalShapes?: Face[]) {
    super();
  }

  match(shape: Face): boolean {
    return this.shapes[this.index] !== shape;
  }

  compareTo(other: NotAtIndexFilter): boolean {
    if (this.index !== other.index) {
      return false;
    }

    if (this.shapes.length !== other.shapes.length) {
      return false;
    }

    return true;
  }

  transform(matrix: Matrix4): NotAtIndexFilter {
    if (matrix.isMirroring() && this.originalShapes) {
      const source = this.originalShapes[this.index];
      const bbox = ShapeOps.getBoundingBox(source);
      const originalCenter = new Point(bbox.centerX, bbox.centerY, bbox.centerZ);
      const targetCenter = matrix.transformPoint(originalCenter);

      let bestIndex = this.index;
      let bestDist = Infinity;
      for (let i = 0; i < this.shapes.length; i++) {
        const b = ShapeOps.getBoundingBox(this.shapes[i]);
        const dist = new Point(b.centerX, b.centerY, b.centerZ).distanceTo(targetCenter);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }

      return new NotAtIndexFilter(bestIndex, this.shapes);
    }

    return new NotAtIndexFilter(this.index, this.shapes);
  }
}
