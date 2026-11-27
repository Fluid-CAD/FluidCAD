import { Shape } from "../common/shapes.js";
import { applyFilterStages } from "./filter-base.js";
import { FilterBuilderBase, IndexSelector } from "./filter-builder-base.js";
import { TangentExpander } from "./tangent-expander.js";
import { ChainExpander } from "./chain-expander.js";

export class ShapeFilter {
  private builders: FilterBuilderBase[];

  constructor(private shapes: Shape[], ...filterBuilders: FilterBuilderBase[]) {
    this.builders = filterBuilders;
  }

  /**
   * Each builder on its own: its stages accept a set of the candidates, its
   * positional selector picks among them, and a `withChain()` builder grows
   * its picks within what it accepted. The builders' results are joined,
   * then grown along tangent neighbours over every candidate when any
   * builder asked for `withTangents()`.
   */
  apply() {

    if (!this.builders?.length) {
      return this.shapes;
    }

    const result = new Set<Shape>();

    for (const builder of this.builders) {
      for (const s of this.applyBuilder(builder)) {
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

  /** One builder's shapes, its chain grown (before the builders are joined). */
  private applyBuilder(builder: FilterBuilderBase): Shape[] {
    // Stages preserve input (OCC iteration) order so positional selectors
    // (.first/.last/.at) are deterministic.
    const filters = builder.getFilters();
    const sel = builder.getIndexSelector();
    if (!builder.hasChainExpansion()) {
      return ShapeFilter.pick(applyFilterStages(this.shapes, filters), sel);
    }

    builder.checkChainSeed();
    if (builder.chainSeedRule() === 'selector') {
      const territory = applyFilterStages(this.shapes, filters);
      return ChainExpander.expand(ShapeFilter.pick(territory, sel), territory);
    }
    // A trailing rank picks the seeds among what the stages before it accept.
    const territory = applyFilterStages(this.shapes, filters.slice(0, -1));
    const seeds = applyFilterStages(territory, filters.slice(-1));
    return ChainExpander.expand(seeds, territory);
  }

  private static pick(matched: Shape[], sel: IndexSelector | undefined): Shape[] {
    if (!sel) {
      return matched;
    }
    if (sel.type === 'first') {
      return matched.length > 0 ? [matched[0]] : [];
    }
    if (sel.type === 'last') {
      return matched.length > 0 ? [matched[matched.length - 1]] : [];
    }
    return sel.index < matched.length ? [matched[sel.index]] : [];
  }
}
