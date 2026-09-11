import { Shape } from "../common/shapes.js";
import { applyFilterStages } from "./filter-base.js";
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

    const result = new Set<Shape>();

    for (const builder of this.builders) {
      // Per-builder ordered match list — stages preserve input (OCC iteration)
      // order so positional selectors (.first/.last/.at) are deterministic.
      const matched = applyFilterStages(this.shapes, builder.getFilters());

      const sel = builder.getIndexSelector();
      let selected: Shape[];
      if (!sel) {
        selected = matched;
      }
      else if (sel.type === 'first') {
        selected = matched.length > 0 ? [matched[0]] : [];
      }
      else if (sel.type === 'last') {
        selected = matched.length > 0 ? [matched[matched.length - 1]] : [];
      }
      else {
        selected = sel.index < matched.length ? [matched[sel.index]] : [];
      }

      for (const s of selected) {
        result.add(s);
      }
    }

    const resultArr = [...result];

    // Tangent expansion: if any builder requests it, expand result set via BFS
    const needsExpansion = this.builders.some(b => b.hasTangentExpansion());
    if (needsExpansion && resultArr.length > 0) {
      return TangentExpander.expand(resultArr, this.shapes);
    }

    return resultArr;
  }
}
