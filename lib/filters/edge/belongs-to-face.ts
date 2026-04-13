import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FilterBuilderBase } from "../filter-builder-base.js";

export class BelongsToFaceFilter extends FilterBase<Edge> {
  private scopeFaces: Face[] = [];

  constructor(private faceFilterBuilders: FilterBuilderBase<Face>[]) {
    super();
  }

  setScopeFaces(faces: Face[]) {
    this.scopeFaces = faces;
  }

  match(shape: Edge): boolean {
    const containingFaces = this.scopeFaces.filter(face =>
      face.hasEdge(shape.getShape()) !== null
    );

    return this.faceFilterBuilders.every(builder => {
      const filters = builder.getFilters();
      return containingFaces.some(face =>
        filters.every(f => f.match(face))
      );
    });
  }

  compareTo(other: BelongsToFaceFilter): boolean {
    if (this.faceFilterBuilders.length !== other.faceFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.faceFilterBuilders.length; i++) {
      if (!this.faceFilterBuilders[i].equals(other.faceFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): BelongsToFaceFilter {
    const transformed = this.faceFilterBuilders.map(builder => builder.transform(matrix));
    return new BelongsToFaceFilter(transformed);
  }
}

export class NotBelongsToFaceFilter extends FilterBase<Edge> {
  private scopeFaces: Face[] = [];

  constructor(private faceFilterBuilders: FilterBuilderBase<Face>[]) {
    super();
  }

  setScopeFaces(faces: Face[]) {
    this.scopeFaces = faces;
  }

  match(shape: Edge): boolean {
    const containingFaces = this.scopeFaces.filter(face =>
      face.hasEdge(shape.getShape()) !== null
    );

    return !this.faceFilterBuilders.every(builder => {
      const filters = builder.getFilters();
      return containingFaces.some(face =>
        filters.every(f => f.match(face))
      );
    });
  }

  compareTo(other: NotBelongsToFaceFilter): boolean {
    if (this.faceFilterBuilders.length !== other.faceFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.faceFilterBuilders.length; i++) {
      if (!this.faceFilterBuilders[i].equals(other.faceFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): NotBelongsToFaceFilter {
    const transformed = this.faceFilterBuilders.map(builder => builder.transform(matrix));
    return new NotBelongsToFaceFilter(transformed);
  }
}
