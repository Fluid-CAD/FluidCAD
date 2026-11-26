import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Matrix4 } from "../math/matrix4.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { ShapeFilter } from "../filters/filter.js";
import { applyBucketFilters } from "../filters/bucket-scope.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";

/** What a face bucket's accessor takes: indices into the bucket, or filters over it. */
export type FaceBucketArgs = (number | FaceFilterBuilder)[];

/** What an edge bucket's accessor takes: indices into the bucket, or filters over it. */
export type EdgeBucketArgs = (number | EdgeFilterBuilder)[];

/**
 * The lazy selection a bucket accessor answers with (`c.edges(0)`,
 * `s.boundaryEdges(edge().line())`): the bucket read off the feature's state
 * when the selection builds, then narrowed by the accessor's arguments.
 *
 * With no argument it is the whole bucket. Indices count over the bucket; on
 * a moved copy (a repeat's or a mirror's instance) an index names the root
 * original's member carried by the move (`SceneObject.bucketOrigin`), so
 * `c.edges(1)` carried onto a copy and the copy's own `edges(1)` are the same
 * edge. Filters run over the bucket with the feature's own bodies in scope.
 */
export class BucketSelection {

  /** The selection over `owner`'s face bucket at state `key`. `name` is the selection's unique name. */
  static faces(owner: SceneObject, name: string, key: string, args: FaceBucketArgs): LazySelectionSceneObject {
    return BucketSelection.over<Face>(owner, name, key, args, (index, members, original) =>
      new FaceFilterBuilder().atIndex(index, members, original ?? undefined));
  }

  /** The selection over `owner`'s edge bucket at state `key`. `name` is the selection's unique name. */
  static edges(owner: SceneObject, name: string, key: string, args: EdgeBucketArgs): LazySelectionSceneObject {
    return BucketSelection.over<Edge>(owner, name, key, args, (index, members, original) =>
      new EdgeFilterBuilder().atIndex(index, members, original ?? undefined));
  }

  /** The tail of a selection's unique name: the bucket's key, then each index (`f` for a filter). */
  static suffix(key: string, args: readonly unknown[]): string {
    if (args.length === 0) {
      return key;
    }
    return `${key}-${args.map(arg => (typeof arg === 'number' ? arg : 'f')).join('-')}`;
  }

  private static over<T extends Shape>(
    owner: SceneObject,
    name: string,
    key: string,
    args: (number | FilterBuilderBase<T>)[],
    atIndex: (index: number, members: T[], original: T[] | null) => FilterBuilderBase<T>,
  ): LazySelectionSceneObject {
    return new LazySelectionSceneObject(name, parent => {
      const members = (parent.getState(key) as T[] | undefined) ?? [];
      const transform = parent.getTransform();
      const original = transform ? ((owner.bucketOrigin().getState(key) as T[] | undefined) ?? []) : null;
      if (args.length === 0) {
        return members;
      }
      const moved = (builders: FilterBuilderBase<T>[]) => BucketSelection.moved(builders, transform);
      if (args.every(arg => typeof arg === 'number')) {
        const builders = moved((args as number[]).map(index => atIndex(index, members, original)));
        return new ShapeFilter(members, ...(builders as unknown as FilterBuilderBase<Shape>[])).apply();
      }
      const builders = moved(args.filter((arg): arg is FilterBuilderBase<T> => typeof arg !== 'number'));
      return applyBucketFilters(members, builders, parent);
    }, owner, args as (number | FilterBuilderBase<Shape>)[]);
  }

  private static moved<T extends Shape>(builders: FilterBuilderBase<T>[], transform: Matrix4 | null): FilterBuilderBase<T>[] {
    return transform ? builders.map(builder => builder.transform(transform)) : builders;
  }
}
