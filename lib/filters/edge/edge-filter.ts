import { PlaneLike } from "../../math/plane.js";
import { normalizePlane } from "../../helpers/normalize.js";
import { Edge, Face } from "../../common/shapes.js";
import { FilterBuilderBase } from "../filter-builder-base.js";
import { CircleFilter, NotCircleFilter } from "./circle-filter.js";
import { ArcFilter, NotArcFilter } from "./curve-filter.js";
import { LineFilter, NotLineFilter } from "./line-filter.js";
import { NotOnPlaneFilter, OnPlaneFilter } from "./on-plane.js";
import { ParallelPlaneFilter, NotParallelPlaneFilter } from "./parallel.js";
import { NotVerticalFilter, VerticalFilter } from "./vertical-plane.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { AtIndexFilter, NotAtIndexFilter } from "./at-index.js";
import { BelongsToFaceFilter, NotBelongsToFaceFilter } from "./belongs-to-face.js";
import { BelongsToFaceFromSceneObjectFilter, NotBelongsToFaceFromSceneObjectFilter } from "./belongs-to-object.js";
import { IntersectsWithFilter, NotIntersectsWithFilter } from "./intersects-with.js";
import { AbovePlaneFilter, BelowPlaneFilter } from "./above-below.js";
import { SceneObject } from "../../common/scene-object.js";
import { ISceneObject } from "../../core/interfaces.js";

export class EdgeFilterBuilder extends FilterBuilderBase<Edge> {
  constructor() {
    super();
  }

  /**
   * Selects the edge at the given index.
   * @param index - Zero-based edge index.
   * @param shapes - The edge array to index into.
   * @param originalShapes - Optional original edge array before filtering.
   * @internal
   */
  atIndex(index: number, shapes: Edge[], originalShapes?: Edge[]) {
    const filter = new AtIndexFilter(index, shapes, originalShapes);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes the edge at the given index.
   * @param index - Zero-based edge index to exclude.
   * @param shapes - The edge array to index into.
   * @param originalShapes - Optional original edge array before filtering.
   * @internal
   */
  notAtIndex(index: number, shapes: Edge[], originalShapes?: Edge[]) {
    const filter = new NotAtIndexFilter(index, shapes, originalShapes);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that lie on the given plane.
   * @param plane - The reference plane.
   * @param offsetOrOptions - Offset distance, or an options object with `offset`, `bothDirections`, and `partial`.
   */
  onPlane(plane: PlaneLike | PlaneObjectBase, offsetOrOptions?: number | { offset?: number; bothDirections?: boolean; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, bothDirections = false, partial = false } = opts;
    let planeObj: PlaneObjectBase;
    let planeObj2: PlaneObjectBase | undefined;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      let normalized = normalizePlane(plane);

      if (offset) {
        planeObj = new PlaneObject(normalized.offset(offset));
        if (bothDirections) {
          planeObj2 = new PlaneObject(normalized.offset(-offset));
        }
      }
      else {
        planeObj = new PlaneObject(normalized);
      }
    }

    const filter = new OnPlaneFilter(planeObj, planeObj2, partial);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes edges that lie on the given plane.
   * @param plane - The reference plane.
   * @param offsetOrOptions - Offset distance, or an options object with `offset`, `bothDirections`, and `partial`.
   */
  notOnPlane(plane: PlaneLike | PlaneObjectBase, offsetOrOptions?: number | { offset?: number; bothDirections?: boolean; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, bothDirections = false, partial = false } = opts;
    let planeObj: PlaneObjectBase;
    let planeObj2: PlaneObjectBase | undefined;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      let normalized = normalizePlane(plane);

      if (offset) {
        planeObj = new PlaneObject(normalized.offset(offset));
        if (bothDirections) {
          planeObj2 = new PlaneObject(normalized.offset(-offset));
        }
      }
      else {
        planeObj = new PlaneObject(normalized);
      }
    }

    const filter = new NotOnPlaneFilter(planeObj, planeObj2, partial);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that are parallel to the given plane.
   * @param plane - The reference plane.
   */
  parallelTo(plane: PlaneLike | PlaneObjectBase) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      planeObj = new PlaneObject(normalizePlane(plane));
    }

    const filter = new ParallelPlaneFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes edges that are parallel to the given plane.
   * @param plane - The reference plane.
   */
  notParallelTo(plane: PlaneLike | PlaneObjectBase) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      planeObj = new PlaneObject(normalizePlane(plane));
    }

    const filter = new NotParallelPlaneFilter(planeObj);
    this.filters.push(filter);
    return this;
  }


  /**
   * Selects edges that are perpendicular (vertical) to the given plane.
   * @param plane - The reference plane.
   */
  verticalTo(plane: PlaneLike | PlaneObjectBase) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      planeObj = new PlaneObject(normalizePlane(plane));
    }

    const filter = new VerticalFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes edges that are perpendicular (vertical) to the given plane.
   * @param plane - The reference plane.
   */
  notVerticalTo(plane: PlaneLike | PlaneObjectBase) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      planeObj = new PlaneObject(normalizePlane(plane));
    }

    const filter = new NotVerticalFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects circular edges, optionally matching a specific diameter.
   * @param diameter - Optional diameter to match.
   */
  circle(diameter?: number) {
    const filter = new CircleFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes circular edges, optionally matching a specific diameter.
   * @param diameter - Optional diameter to exclude.
   */
  notCircle(diameter?: number) {
    const filter = new NotCircleFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects arc edges, optionally matching a specific radius.
   * @param radius - Optional radius to match.
   */
  arc(radius?: number) {
    const filter = new ArcFilter(radius);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes arc edges, optionally matching a specific radius.
   * @param radius - Optional radius to exclude.
   */
  notArc(radius?: number) {
    const filter = new NotArcFilter(radius);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects straight-line edges, optionally matching a specific length.
   * @param length - Optional length to match.
   */
  line(length?: number) {
    const filter = new LineFilter(length);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes straight-line edges, optionally matching a specific length.
   * @param length - Optional length to exclude.
   */
  notLine(length?: number) {
    const filter = new NotLineFilter(length);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that belong to a face from the given scene object.
   * @param sceneObject - A scene object whose faces are matched against.
   */
  belongsToFace(sceneObject: ISceneObject): this;
  /**
   * Selects edges that belong to a face matching the given face filters.
   * @param faceFilters - One or more face filter builders to match against.
   */
  belongsToFace(...faceFilters: FilterBuilderBase<Face>[]): this;
  belongsToFace(...args: any[]): this {
    const filterBuilders: FilterBuilderBase<Face>[] = [];
    for (const arg of args) {
      if (arg instanceof SceneObject) {
        this.filters.push(new BelongsToFaceFromSceneObjectFilter(arg));
      } else {
        filterBuilders.push(arg as FilterBuilderBase<Face>);
      }
    }
    if (filterBuilders.length > 0) {
      this.filters.push(new BelongsToFaceFilter(filterBuilders));
    }
    return this;
  }

  /**
   * Excludes edges that belong to a face from the given scene object.
   * @param sceneObject - A scene object whose faces are matched against.
   */
  notBelongsToFace(sceneObject: ISceneObject): this;
  /**
   * Excludes edges that belong to a face matching the given face filters.
   * @param faceFilters - One or more face filter builders to match against.
   */
  notBelongsToFace(...faceFilters: FilterBuilderBase<Face>[]): this;
  notBelongsToFace(...args: any[]): this {
    const filterBuilders: FilterBuilderBase<Face>[] = [];
    for (const arg of args) {
      if (arg instanceof SceneObject) {
        this.filters.push(new NotBelongsToFaceFromSceneObjectFilter(arg));
      } else {
        filterBuilders.push(arg as FilterBuilderBase<Face>);
      }
    }
    if (filterBuilders.length > 0) {
      this.filters.push(new NotBelongsToFaceFilter(filterBuilders));
    }
    return this;
  }

  /**
   * Selects edges that geometrically intersect with edges of the given scene object.
   * @param sceneObject - A scene object whose edges are tested for intersection.
   */
  intersectsWith(sceneObject: ISceneObject) {
    const filter = new IntersectsWithFilter(sceneObject as SceneObject);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes edges that geometrically intersect with edges of the given scene object.
   * @param sceneObject - A scene object whose edges are tested for intersection.
   */
  notIntersectsWith(sceneObject: ISceneObject) {
    const filter = new NotIntersectsWithFilter(sceneObject as SceneObject);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that are entirely above the given plane (in the direction of its normal).
   * @param plane - The reference plane.
   * @param offsetOrOptions - Offset distance, or an options object with `offset` and `partial`.
   */
  above(plane: PlaneLike | PlaneObjectBase, offsetOrOptions?: number | { offset?: number; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, partial = false } = opts;
    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      let normalized = normalizePlane(plane);
      planeObj = offset ? new PlaneObject(normalized.offset(offset)) : new PlaneObject(normalized);
    }

    const filter = new AbovePlaneFilter(planeObj, partial);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that are entirely below the given plane (opposite to its normal direction).
   * @param plane - The reference plane.
   * @param offsetOrOptions - Offset distance, or an options object with `offset` and `partial`.
   */
  below(plane: PlaneLike | PlaneObjectBase, offsetOrOptions?: number | { offset?: number; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, partial = false } = opts;
    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      let normalized = normalizePlane(plane);
      planeObj = offset ? new PlaneObject(normalized.offset(offset)) : new PlaneObject(normalized);
    }

    const filter = new BelowPlaneFilter(planeObj, partial);
    this.filters.push(filter);
    return this;
  }

  static build() {
    return new EdgeFilterBuilder();
  }
}
