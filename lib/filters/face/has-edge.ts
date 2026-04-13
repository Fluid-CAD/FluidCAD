import { Matrix4 } from "../../math/matrix4.js";
import { Edge, Face } from "../../common/shapes.js";
import { FilterBase } from "../filter-base.js";
import { FilterBuilderBase } from "../filter-builder-base.js";

export class HasEdgeFilter extends FilterBase<Face> {
  constructor(private edgeFilterBuilders: FilterBuilderBase<Edge>[]) {
    super();
  }

  match(shape: Face): boolean {
    const edges = shape.getEdges();

    return this.edgeFilterBuilders.every(builder => {
      const filters = builder.getFilters();
      return edges.some(edge =>
        filters.every(f => f.match(edge))
      );
    });
  }

  compareTo(other: HasEdgeFilter): boolean {
    if (this.edgeFilterBuilders.length !== other.edgeFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.edgeFilterBuilders.length; i++) {
      if (!this.edgeFilterBuilders[i].equals(other.edgeFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): HasEdgeFilter {
    const transformed = this.edgeFilterBuilders.map(builder => builder.transform(matrix));
    return new HasEdgeFilter(transformed);
  }
}

export class NotHasEdgeFilter extends FilterBase<Face> {
  constructor(private edgeFilterBuilders: FilterBuilderBase<Edge>[]) {
    super();
  }

  match(shape: Face): boolean {
    const edges = shape.getEdges();

    return !this.edgeFilterBuilders.every(builder => {
      const filters = builder.getFilters();
      return edges.some(edge =>
        filters.every(f => f.match(edge))
      );
    });
  }

  compareTo(other: NotHasEdgeFilter): boolean {
    if (this.edgeFilterBuilders.length !== other.edgeFilterBuilders.length) {
      return false;
    }
    for (let i = 0; i < this.edgeFilterBuilders.length; i++) {
      if (!this.edgeFilterBuilders[i].equals(other.edgeFilterBuilders[i])) {
        return false;
      }
    }
    return true;
  }

  transform(matrix: Matrix4): NotHasEdgeFilter {
    const transformed = this.edgeFilterBuilders.map(builder => builder.transform(matrix));
    return new NotHasEdgeFilter(transformed);
  }
}
