import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shapes.js";
import { FilterBase } from "./filter-base.js";

export class FilterBuilderBase<TShape extends Shape = Shape> {
  protected filters: FilterBase<TShape>[] = [];

  filter(filter: FilterBase<TShape>) {
    this.filters.push(filter);
    return this;
  }

  getFilters() {
    return this.filters;
  }

  transform(matrix: Matrix4): FilterBuilderBase<TShape> {
    const transformedBuilder = new FilterBuilderBase<TShape>();
    for (const filter of this.filters) {
      transformedBuilder.filter(filter.transform(matrix) as FilterBase<TShape>);
    }
    return transformedBuilder;
  }

  equals(other: FilterBuilderBase<TShape>): boolean {
    if (this.filters.length !== other.filters.length) {
      return false;
    }

    for (let i = 0; i < this.filters.length; i++) {
      if (this.filters[i].constructor !== other.filters[i].constructor) {
        return false;
      }

      if (!this.filters[i].compareTo(other.filters[i])) {
        return false;
      }
    }

    return true;
  }
}
