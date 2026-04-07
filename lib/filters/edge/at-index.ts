import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { EdgeOps } from "../../oc/edge-ops.js";

export class AtIndexFilter extends FilterBase<Edge> {
  constructor(private index: number, private shapes: Edge[], private originalShapes?: Edge[]) {
    super();
  }

  match(shape: Edge): boolean {
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
      const originalMidpoint = EdgeOps.getEdgeMidPoint(this.originalShapes[this.index]);
      const targetMidpoint = matrix.transformPoint(originalMidpoint);

      let bestIndex = this.index;
      let bestDist = Infinity;
      for (let i = 0; i < this.shapes.length; i++) {
        const dist = EdgeOps.getEdgeMidPoint(this.shapes[i]).distanceTo(targetMidpoint);
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

export class NotAtIndexFilter extends FilterBase<Edge> {
  constructor(private index: number, private shapes: Edge[], private originalShapes?: Edge[]) {
    super();
  }

  match(shape: Edge): boolean {
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
      const originalMidpoint = EdgeOps.getEdgeMidPoint(this.originalShapes[this.index]);
      const targetMidpoint = matrix.transformPoint(originalMidpoint);

      let bestIndex = this.index;
      let bestDist = Infinity;
      for (let i = 0; i < this.shapes.length; i++) {
        const dist = EdgeOps.getEdgeMidPoint(this.shapes[i]).distanceTo(targetMidpoint);
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
