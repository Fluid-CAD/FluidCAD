import { Matrix4 } from "../../math/matrix4.js";
import { Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { MirrorIndex } from "../mirror-index.js";

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
      return new AtIndexFilter(MirrorIndex.FACES.image(this.index, this.shapes, this.originalShapes, matrix), this.shapes);
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
      return new NotAtIndexFilter(MirrorIndex.FACES.image(this.index, this.shapes, this.originalShapes, matrix), this.shapes);
    }

    return new NotAtIndexFilter(this.index, this.shapes);
  }
}
