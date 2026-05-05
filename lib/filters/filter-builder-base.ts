import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shapes.js";
import { SceneObject } from "../common/scene-object.js";
import { FilterBase } from "./filter-base.js";

export type IndexSelector =
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'at'; index: number };

export class FilterBuilderBase<TShape extends Shape = Shape> {
  protected filters: FilterBase<TShape>[] = [];
  protected _withTangents: boolean = false;
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
    * @internal
  */
  transform(matrix: Matrix4): FilterBuilderBase<TShape> {
    const transformedBuilder = new FilterBuilderBase<TShape>();
    for (const filter of this.filters) {
      transformedBuilder.filter(filter.transform(matrix) as FilterBase<TShape>);
    }
    transformedBuilder._withTangents = this._withTangents;
    // Index is invariant under Matrix4: the selector is re-applied against
    // the transformed shape's own ordered match list at evaluation time.
    transformedBuilder._indexSelector = this._indexSelector;
    return transformedBuilder;
  }

  /**
    * @internal
  */
  remap(remap: Map<SceneObject, SceneObject>): FilterBuilderBase<TShape> {
    const remappedBuilder = new FilterBuilderBase<TShape>();
    for (const filter of this.filters) {
      remappedBuilder.filter(filter.remap(remap) as FilterBase<TShape>);
    }
    remappedBuilder._withTangents = this._withTangents;
    remappedBuilder._indexSelector = this._indexSelector;
    return remappedBuilder;
  }

  /**
    * @internal
  */
  equals(other: FilterBuilderBase<TShape>): boolean {
    if (this._withTangents !== other._withTangents) {
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
