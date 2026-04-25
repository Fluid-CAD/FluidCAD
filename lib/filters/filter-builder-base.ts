import { Matrix4 } from "../math/matrix4.js";
import { Shape } from "../common/shapes.js";
import { SceneObject } from "../common/scene-object.js";
import { FilterBase } from "./filter-base.js";

export class FilterBuilderBase<TShape extends Shape = Shape> {
  protected filters: FilterBase<TShape>[] = [];
  protected _withTangents: boolean = false;

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
    * @internal
  */
  hasTangentExpansion(): boolean {
    return this._withTangents;
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
    return remappedBuilder;
  }

  /**
    * @internal
  */
  equals(other: FilterBuilderBase<TShape>): boolean {
    if (this._withTangents !== other._withTangents) {
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
