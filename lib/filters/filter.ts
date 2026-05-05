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

    const result = new Set<Shape>();

    for (const builder of this.builders) {
      const filters = builder.getFilters();
      // Per-builder ordered match list — preserves input (OCC iteration) order
      // so positional selectors (.first/.last/.at) are deterministic.
      const matched: Shape[] = [];
      for (const shape of this.shapes) {
        let ok = true;
        for (const f of filters) {
          try {
            if (!f.match(shape)) {
              ok = false;
              break;
            }
          }
          catch (e) {
            console.error('Error applying filter:', e, f);
            ok = false;
            break;
          }
        }
        if (ok) {
          matched.push(shape);
        }
      }

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

