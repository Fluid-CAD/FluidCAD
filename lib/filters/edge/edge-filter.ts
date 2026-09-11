import { PlaneLike } from "../../math/plane.js";
import { normalizePlane } from "../../helpers/normalize.js";
import { Edge, Face } from "../../common/shapes.js";
import { materializePartArgs } from "../../features/part-args.js";
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
import { FromSceneObjectFilter } from "../from-object.js";
import { IntersectsWithFilter, NotIntersectsWithFilter } from "./intersects-with.js";
import { AbovePlaneFilter, BelowPlaneFilter } from "./above-below.js";
import { SceneObject } from "../../common/scene-object.js";
import { ISceneObject } from "../../core/interfaces.js";
import { PlaneRefSource } from "../plane-ref.js";
import { DirectionLike } from "../direction.js";
import { ConvexityFilter } from "./convexity.js";
import { ExtremalFilter } from "../rank/extremal.js";
import { MeasureExtremeFilter, SizeMeasure } from "../rank/measure.js";


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
   * Selects edges that lie on the given plane. Besides a standard plane or a
   * plane feature, any scene object whose first shape is a face works as the
   * reference — a bucket accessor like `e.endFaces()`, or a select(). The
   * face is only read to derive its plane (no plane feature is created, and
   * the referenced geometry is not consumed), so the reference stays valid
   * even when a later feature reshaped or consumed the face.
   * @param plane - The reference plane, plane feature, or face selection.
   * @param offsetOrOptions - Offset distance, or an options object with `offset`, `bothDirections`, and `partial` (offsets apply to standard planes only).
   */
  onPlane(plane: PlaneLike | PlaneObjectBase | ISceneObject, offsetOrOptions?: number | { offset?: number; bothDirections?: boolean; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, bothDirections = false, partial = false } = opts;
    let planeObj: PlaneObjectBase | SceneObject;
    let planeObj2: PlaneObjectBase | undefined;

    if (plane instanceof PlaneObjectBase || plane instanceof SceneObject) {
      planeObj = plane;
    }
    else {
      let normalized = normalizePlane(plane as PlaneLike);

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
  notOnPlane(plane: PlaneLike | PlaneObjectBase | ISceneObject, offsetOrOptions?: number | { offset?: number; bothDirections?: boolean; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, bothDirections = false, partial = false } = opts;
    let planeObj: PlaneObjectBase | SceneObject;
    let planeObj2: PlaneObjectBase | undefined;

    if (plane instanceof PlaneObjectBase || plane instanceof SceneObject) {
      planeObj = plane;
    }
    else {
      let normalized = normalizePlane(plane as PlaneLike);

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
   * Selects edges that are entirely above the given plane (in the direction of its normal). Besides a
   * standard plane or a plane feature, any scene object whose first shape is
   * a face works as the reference — a bucket accessor like `base.endFaces()`
   * — so the half-space follows the referenced feature through edits. The
   * offset runs along the resolved plane's normal.
   * @param plane - The reference plane, plane feature, or face selection.
   * @param offsetOrOptions - Offset distance, or an options object with `offset` and `partial`.
   */
  above(plane: PlaneLike | PlaneObjectBase | ISceneObject, offsetOrOptions?: number | { offset?: number; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, partial = false } = opts;
    const planeRef: PlaneRefSource = plane instanceof PlaneObjectBase || plane instanceof SceneObject
      ? plane
      : new PlaneObject(normalizePlane(plane as PlaneLike));

    const filter = new AbovePlaneFilter(planeRef, partial, offset);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that are entirely below the given plane (opposite to its normal direction). Besides a
   * standard plane or a plane feature, any scene object whose first shape is
   * a face works as the reference — a bucket accessor like `base.endFaces()`
   * — so the half-space follows the referenced feature through edits. The
   * offset runs along the resolved plane's normal.
   * @param plane - The reference plane, plane feature, or face selection.
   * @param offsetOrOptions - Offset distance, or an options object with `offset` and `partial`.
   */
  below(plane: PlaneLike | PlaneObjectBase | ISceneObject, offsetOrOptions?: number | { offset?: number; partial?: boolean }) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    const opts = typeof offsetOrOptions === 'number' ? { offset: offsetOrOptions } : (offsetOrOptions ?? {});
    const { offset = 0, partial = false } = opts;
    const planeRef: PlaneRefSource = plane instanceof PlaneObjectBase || plane instanceof SceneObject
      ? plane
      : new PlaneObject(normalizePlane(plane as PlaneLike));

    const filter = new BelowPlaneFilter(planeRef, partial, offset);
    this.filters.push(filter);
    return this;
  }

  /**
   * Restricts the selection to edges originating from the given scene objects.
   * Recursive: passing a container picks up edges from its descendants.
   * @param sceneObjects - Scene objects whose edges (and edges of their sub-shapes) are matched against.
   */
  from(...sceneObjects: ISceneObject[]): this {
    // Part definitions coerce to their built default variant at argument
    // time, so the donor's geometry precedes the consuming select().
    const filter = new FromSceneObjectFilter<Edge>(materializePartArgs(sceneObjects) as SceneObject[], "edge");
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects convex edges — outer corners, where the solid's two faces meet
   * at an angle opening outward. The classic fillet target: `e.sideEdges(edge().convex())`
   * rounds every outer vertical corner of a profile and leaves its inner
   * corners sharp.
   */
  convex() {
    this.filters.push(new ConvexityFilter('convex'));
    return this;
  }

  /** Excludes convex edges (outer corners). */
  notConvex() {
    this.filters.push(new ConvexityFilter('convex', true));
    return this;
  }

  /**
   * Selects concave edges — inner corners, where a boss meets its base or a
   * pocket wall meets its floor.
   */
  concave() {
    this.filters.push(new ConvexityFilter('concave'));
    return this;
  }

  /** Excludes concave edges (inner corners). */
  notConcave() {
    this.filters.push(new ConvexityFilter('concave', true));
    return this;
  }

  /**
   * Selects smooth edges — no corner at all, the two faces being tangent
   * there, as along a fillet's boundary.
   */
  smooth() {
    this.filters.push(new ConvexityFilter('smooth'));
    return this;
  }

  /** Excludes smooth (tangent-transition) edges. */
  notSmooth() {
    this.filters.push(new ConvexityFilter('smooth', true));
    return this;
  }

  /**
   * Keeps the layer of edges farthest along a direction — every edge whose
   * center of mass lies at the maximum (within tolerance) along it. A box's
   * `farthest('z')` is its four top rim edges; chain order is evaluation
   * order, so `edge().line().farthest('z')` ranks only the lines.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  farthest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Edge>(direction, { kind: 'farthest' }));
    return this;
  }

  /**
   * Excludes the layer of edges farthest along a direction.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  notFarthest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Edge>(direction, { kind: 'farthest' }, true));
    return this;
  }

  /**
   * Keeps the layer of edges nearest along a direction — the minimum of the
   * center of mass along it (`nearest('z')` is the same as `farthest('-z')`).
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  nearest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Edge>(direction, { kind: 'nearest' }));
    return this;
  }

  /**
   * Excludes the layer of edges nearest along a direction.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  notNearest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Edge>(direction, { kind: 'nearest' }, true));
    return this;
  }

  /**
   * Keeps the k-th layer of edges along a direction, counting layers of
   * equal center position from the near end (0-based); a negative index
   * counts from the far end, so `nth('z', -1)` is `farthest('z')`.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   * @param index - Layer index; out-of-range indices match nothing.
   */
  nth(direction: DirectionLike, index: number) {
    if (!Number.isInteger(index)) {
      throw new Error(`nth(direction, index): index must be an integer (got ${index})`);
    }
    this.filters.push(new ExtremalFilter<Edge>(direction, { kind: 'nth', index }));
    return this;
  }

  /**
   * Keeps the largest edges — by length unless a measure is given — including
   * every edge that ties with the largest.
   * @param measure - `'length'` (default) or `'radius'` for circular edges.
   */
  largest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Edge>('largest', measure));
    return this;
  }

  /**
   * Excludes the largest edges (and their ties).
   * @param measure - `'length'` (default) or `'radius'`.
   */
  notLargest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Edge>('largest', measure, true));
    return this;
  }

  /**
   * Keeps the smallest edges — by length unless a measure is given — including
   * every edge that ties with the smallest.
   * @param measure - `'length'` (default) or `'radius'` for circular edges.
   */
  smallest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Edge>('smallest', measure));
    return this;
  }

  /**
   * Excludes the smallest edges (and their ties).
   * @param measure - `'length'` (default) or `'radius'`.
   */
  notSmallest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Edge>('smallest', measure, true));
    return this;
  }

  static build() {
    return new EdgeFilterBuilder();
  }
}
