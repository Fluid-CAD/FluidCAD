import { Matrix4 } from "../../math/matrix4.js";
import { Edge } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { MirrorIndex } from "../mirror-index.js";

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
      return new AtIndexFilter(MirrorIndex.EDGES.image(this.index, this.shapes, this.originalShapes, matrix), this.shapes);
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
      return new NotAtIndexFilter(MirrorIndex.EDGES.image(this.index, this.shapes, this.originalShapes, matrix), this.shapes);
    }

    return new NotAtIndexFilter(this.index, this.shapes);
  }
}
