import { Shape } from "../common/shapes.js";
import { FilterBuilderBase } from "./filter-builder-base.js";
import { TangentExpander } from "./tangent-expander.js";

export class ShapeFilter {
  private builders: FilterBuilderBase[];

  constructor(private shapes: Shape[], ...filterBuilders: FilterBuilderBase[]) {
    this.builders = filterBuilders;
  }

  apply() {

    if (!this.builders?.length) {
      return this.shapes;
    }

    const result: Shape[] = [];
    for (const shape of this.shapes) {
      for (const filter of this.builders) {
        const filters = filter.getFilters();
        if (filters.every(f => {
          try {
            return f.match(shape)
          }
          catch (e) {
            console.error('Error applying filter:', e, f);
            return false;
          }
        })) {
          if (!result.includes(shape)) {
            result.push(shape);
          }
        }
      }
    }

    // Tangent expansion: if any builder requests it, expand result set via BFS
    const needsExpansion = this.builders.some(b => b.hasTangentExpansion());
    if (needsExpansion && result.length > 0) {
      return TangentExpander.expand(result, this.shapes);
    }

    return result;
  }
}

