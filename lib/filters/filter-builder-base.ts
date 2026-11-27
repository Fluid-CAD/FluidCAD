import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shapes.js";
import { SceneObject } from "../common/scene-object.js";
import { FilterBase } from "./filter-base.js";

export type IndexSelector =
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'at'; index: number };

/** Why a `withChain()` builder with no seed rule is refused. */
export const CHAIN_WITHOUT_SEED =
  "withChain() has no seed to grow from: add at(i), first() or last(), or end the filter with a rank "
  + "(nearest, farthest, nth, largest, smallest) to pick where the chain starts. Without one every matching "
  + "shape is a seed and the chain adds nothing.";

/**
 * Refuses any `withChain()` builder among `args` that has no seed rule — the
 * check `select()` and the bucket accessors run on their arguments where the
 * selection is written. Non-builder arguments (bucket indices) are skipped.
 */
export function checkChainSeeds(args: readonly unknown[]): void {
  for (const arg of args) {
    if (arg instanceof FilterBuilderBase) {
      arg.checkChainSeed();
    }
  }
}

export class FilterBuilderBase<TShape extends Shape = Shape> {
  protected filters: FilterBase<TShape>[] = [];
  protected _withTangents: boolean = false;
  protected _withChain: boolean = false;
  protected _indexSelector?: IndexSelector;

  filter(filter: FilterBase<TShape>) {
    this.filters.push(filter);
    return this;
  }

  /**
   * Expands the selection to include all shapes transitively connected
   * by tangency (G1 continuity) to the initially matched shapes.
   */
  withTangents(): this {
    this._withTangents = true;
    return this;
  }

  /**
   * Grows the selection along connected neighbours, tangent or not: edges
   * that share a vertex, faces that share an edge. The chain never leaves
   * what the builder's predicates accept, so the predicates define the
   * territory and a seed rule plants where the chain starts:
   *
   * - a positional selector — {@link at}, {@link first} or {@link last} —
   *   picks the seed among the accepted shapes; or
   * - with no positional selector, a rank written as the builder's **last
   *   stage** (`nearest`, `farthest`, `nth`, `largest`, `smallest`) picks the
   *   seeds, and the stages before it are the territory.
   *
   * Every accepted shape connected to a seed through accepted shapes joins
   * the selection. Inside a bucket accessor the bucket is the candidate set,
   * so a builder with no predicate chains through the whole bucket.
   *
   * ```js
   * s.boundaryEdges(edge().at(3).withChain())           // the rim loop that holds rim edge 3
   * select(edge().boundary().nearest('z').withChain())  // the rim loops that touch the bottom
   * select(face().cylinder().at(0).withChain())         // the connected run of cylindrical faces holding the first
   * ```
   *
   * A builder with no seed rule is refused where the selection is written:
   * every accepted shape would be a seed and the chain would add nothing.
   * Where `withChain()` sits in the call chain does not matter. Each builder
   * grows its own chain before the builders of a `select()` are joined;
   * {@link withTangents} then grows the joined set, as without a chain.
   */
  withChain(): this {
    this._withChain = true;
    return this;
  }

  /**
   * Selects the first matching shape (in iteration order). If called multiple
   * times on the same builder, the last positional call wins.
   */
  first(): this {
    this._indexSelector = { type: 'first' };
    return this;
  }

  /**
   * Selects the last matching shape (in iteration order). If called multiple
   * times on the same builder, the last positional call wins.
   */
  last(): this {
    this._indexSelector = { type: 'last' };
    return this;
  }

  /**
   * Selects the matching shape at the given zero-based index.
   * Out-of-range indices yield no match. Negative indices are not supported;
   * use {@link last} for the final element.
   */
  at(index: number): this {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`at(index): index must be a non-negative integer (got ${index}). Use last() for the final element.`);
    }
    this._indexSelector = { type: 'at', index };
    return this;
  }

  /**
    * @internal
  */
  hasTangentExpansion(): boolean {
    return this._withTangents;
  }

  /**
    * @internal
  */
  hasChainExpansion(): boolean {
    return this._withChain;
  }

  /**
   * What plants the seeds of this builder's chain: its positional selector,
   * else a rank written as its last stage (see {@link withChain}); null when
   * it has neither.
   * @internal
   */
  chainSeedRule(): 'selector' | 'rank' | null {
    if (this._indexSelector) {
      return 'selector';
    }
    const last = this.filters[this.filters.length - 1];
    return last?.seedsAChain() ? 'rank' : null;
  }

  /**
   * Refuses a `withChain()` builder with no seed rule. Called where a
   * selection is written (`select()`, a bucket accessor), when the builder
   * is complete, and again before it is evaluated.
   * @internal
   */
  checkChainSeed(): void {
    if (this._withChain && !this.chainSeedRule()) {
      throw new Error(CHAIN_WITHOUT_SEED);
    }
  }

  /**
    * @internal
  */
  getIndexSelector(): IndexSelector | undefined {
    return this._indexSelector;
  }

  /**
    * @internal
  */
  getFilters() {
    return this.filters;
  }

  /**
   * A new, empty builder of this one's own class: a transformed or remapped
   * `face()` must still read as a face filter to `select()`, which tells a
   * face selection from an edge one by the builder's class.
   */
  private emptyOfSameKind(): this {
    return new (this.constructor as new () => this)();
  }

  /**
    * @internal
  */
  transform(matrix: Matrix4): this {
    const transformedBuilder = this.emptyOfSameKind();
    for (const filter of this.filters) {
      transformedBuilder.filter(filter.transform(matrix) as FilterBase<TShape>);
    }
    transformedBuilder._withTangents = this._withTangents;
    // Connectivity is invariant under any rigid move or mirror.
    transformedBuilder._withChain = this._withChain;
    // Index is invariant under Matrix4: the selector is re-applied against
    // the transformed shape's own ordered match list at evaluation time.
    transformedBuilder._indexSelector = this._indexSelector;
    return transformedBuilder;
  }

  /**
    * @internal
  */
  remap(remap: Map<SceneObject, SceneObject>): this {
    const remappedBuilder = this.emptyOfSameKind();
    for (const filter of this.filters) {
      remappedBuilder.filter(filter.remap(remap) as FilterBase<TShape>);
    }
    remappedBuilder._withTangents = this._withTangents;
    remappedBuilder._withChain = this._withChain;
    remappedBuilder._indexSelector = this._indexSelector;
    return remappedBuilder;
  }

  /**
    * @internal
  */
  equals(other: FilterBuilderBase<TShape>): boolean {
    if (this._withTangents !== other._withTangents || this._withChain !== other._withChain) {
      return false;
    }

    const a = this._indexSelector;
    const b = other._indexSelector;
    if ((a?.type) !== (b?.type)) {
      return false;
    }
    if (a?.type === 'at' && b?.type === 'at' && a.index !== b.index) {
      return false;
    }

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
