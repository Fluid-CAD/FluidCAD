import { PlaneLike } from "../../math/plane.js";
import { normalizePlane } from "../../helpers/normalize.js";
import { Face } from "../../common/shapes.js";
import { materializePartArgs } from "../../features/part-args.js";
import { FilterBuilderBase } from "../filter-builder-base.js";
import { CircleFilter, NotCircleFilter } from "./circle-filter.js";
import { ConeFilter, NotConeFilter } from "./cone-filter.js";
import { CylinderCurveFilter, NotCylinderCurveFilter } from "./cylinder-curve.js";
import { CylinderFilter, NotCylinderFilter } from "./cylinder.js";
import { TorusFilter, NotTorusFilter } from "./torus-filter.js";
import { PlanarFilter, NotPlanarFilter } from "./planar-filter.js";
import { NotOnPlaneFilter, OnPlaneFilter } from "./on-plane.js";
import { NotParallelFilter, ParallelFilter } from "./parallel.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { AtIndexFilter, NotAtIndexFilter } from "./at-index.js";
import { HasEdgeFilter, NotHasEdgeFilter } from "./has-edge.js";
import { HasEdgeFromSceneObjectFilter, NotHasEdgeFromSceneObjectFilter } from "./has-object.js";
import { FromSceneObjectFilter } from "../from-object.js";
import { EdgeCountFilter, NotEdgeCountFilter } from "./edge-count.js";
import { IntersectsWithFilter, NotIntersectsWithFilter } from "./intersects-with.js";
import { AboveFacePlaneFilter, BelowFacePlaneFilter } from "./above-below.js";
import { EdgeFilterBuilder } from "../edge/edge-filter.js";
import { SceneObject } from "../../common/scene-object.js";
import { ISceneObject } from "../../core/interfaces.js";
import { PlaneRefSource } from "../plane-ref.js";
import { DirectionLike } from "../direction.js";
import { ExtremalFilter } from "../rank/extremal.js";
import { MeasureExtremeFilter, SizeMeasure } from "../rank/measure.js";

export class FaceFilterBuilder extends FilterBuilderBase<Face> {
  constructor() {
    super();
  }

  /**
   * Selects the face at the given index.
   * @param index - Zero-based face index.
   * @param shapes - The face array to index into.
   * @param originalShapes - Optional original face array before filtering.
   * @internal
   */
  atIndex(index: number, shapes: Face[], originalShapes?: Face[]) {
    const filter = new AtIndexFilter(index, shapes, originalShapes);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes the face at the given index.
   * @param index - Zero-based face index to exclude.
   * @param shapes - The face array to index into.
   * @param originalShapes - Optional original face array before filtering.
   * @internal
   */
  notAtIndex(index: number, shapes: Face[], originalShapes?: Face[]) {
    const filter = new NotAtIndexFilter(index, shapes, originalShapes);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces that lie on the given plane. Besides a standard plane or a
   * plane feature, any scene object whose first shape is a face works as the
   * reference — a bucket accessor like `e.endFaces()`, or a select(). The
   * face is only read to derive its plane (no plane feature is created, and
   * the referenced geometry is not consumed), so the reference stays valid
   * even when a later feature reshaped or consumed the face.
   * @param plane - The reference plane, plane feature, or face selection.
   * @param offset - Optional distance to offset a standard plane before matching.
   */
  onPlane(plane: PlaneLike | PlaneObjectBase | ISceneObject, offset = 0) {
    this.filters.push(new OnPlaneFilter(this.resolvePlaneSource(plane, offset)));
    return this;
  }

  /**
   * Excludes faces that lie on the given plane. Accepts the same references
   * as {@link onPlane}, including a face selection to read the plane from.
   * @param plane - The reference plane, plane feature, or face selection.
   * @param offset - Optional distance to offset a standard plane before matching.
   */
  notOnPlane(plane: PlaneLike | PlaneObjectBase | ISceneObject, offset = 0) {
    this.filters.push(new NotOnPlaneFilter(this.resolvePlaneSource(plane, offset)));
    return this;
  }

  /**
   * Normalize an `onPlane` argument to a filter source: plane features and
   * face selections pass through (their plane resolves lazily at match
   * time), a plane-like gets the offset applied and wrapped.
   */
  private resolvePlaneSource(
    plane: PlaneLike | PlaneObjectBase | ISceneObject,
    offset: number,
  ): PlaneObjectBase | SceneObject {
    if (!plane) {
      throw new Error('Plane is required');
    }
    if (plane instanceof PlaneObjectBase || plane instanceof SceneObject) {
      return plane;
    }
    let normalized = normalizePlane(plane as PlaneLike);
    if (offset) {
      normalized = normalized.offset(offset);
    }
    return new PlaneObject(normalized);
  }

  /**
   * Selects circular (flat, disc-shaped) faces, optionally matching a specific diameter.
   * @param diameter - Optional diameter to match.
   */
  circle(diameter?: number) {
    const filter = new CircleFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes circular (flat, disc-shaped) faces, optionally matching a specific diameter.
   * @param diameter - Optional diameter to exclude.
   */
  notCircle(diameter?: number) {
    const filter = new NotCircleFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects cylindrical faces, optionally matching a specific diameter.
   * @param diameter - Optional diameter to match.
   */
  cylinder(diameter?: number) {
    const filter = new CylinderFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes cylindrical faces, optionally matching a specific diameter.
   * @param diameter - Optional diameter to exclude.
   */
  notCylinder(diameter?: number) {
    const filter = new NotCylinderFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces bounded by cylindrical curves, optionally matching a specific diameter.
   * @param diameter - Optional diameter to match.
   */
  cylinderCurve(diameter?: number) {
    const filter = new CylinderCurveFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes faces bounded by cylindrical curves, optionally matching a specific diameter.
   * @param diameter - Optional diameter to exclude.
   */
  notCylinderCurve(diameter?: number) {
    const filter = new NotCylinderCurveFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces whose normal is parallel to the given plane.
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

    const filter = new ParallelFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes faces whose normal is parallel to the given plane.
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

    const filter = new NotParallelFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects toroidal faces, optionally matching major and/or minor radius.
   * @param majorRadius - Optional radius from the torus axis to the tube center.
   * @param minorRadius - Optional radius of the tube itself.
   */
  torus(majorRadius?: number, minorRadius?: number) {
    const filter = new TorusFilter(majorRadius, minorRadius);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes toroidal faces, optionally matching major and/or minor radius.
   * @param majorRadius - Optional radius from the torus axis to the tube center.
   * @param minorRadius - Optional radius of the tube itself.
   */
  notTorus(majorRadius?: number, minorRadius?: number) {
    const filter = new NotTorusFilter(majorRadius, minorRadius);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects planar (flat) faces.
   */
  planar() {
    const filter = new PlanarFilter();
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes planar (flat) faces.
   */
  notPlanar() {
    const filter = new NotPlanarFilter();
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects conical faces.
   */
  cone() {
    const filter = new ConeFilter();
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes conical faces.
   */
  notCone() {
    const filter = new NotConeFilter();
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces that intersect with the given plane.
   * @param plane - The reference plane to test intersection against.
   */
  intersectsWith(plane: PlaneLike | PlaneObjectBase) {
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

    const filter = new IntersectsWithFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes faces that intersect with the given plane.
   * @param plane - The reference plane to test intersection against.
   */
  notIntersectsWith(plane: PlaneLike | PlaneObjectBase) {
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

    const filter = new NotIntersectsWithFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces that share an edge with the given scene object.
   * @param sceneObject - A scene object whose edges are matched against.
   */
  hasEdge(sceneObject: ISceneObject): this;
  /**
   * Selects faces that have edges matching all of the given edge filters.
   * Each edge filter builder must match at least one edge of the face.
   * @param edgeFilters - One or more edge filter builders. All must be satisfied.
   */
  hasEdge(...edgeFilters: EdgeFilterBuilder[]): this;
  hasEdge(...args: any[]): this {
    const filterBuilders: EdgeFilterBuilder[] = [];
    for (const arg of args) {
      if (arg instanceof SceneObject) {
        this.filters.push(new HasEdgeFromSceneObjectFilter(arg));
      } else {
        filterBuilders.push(arg as EdgeFilterBuilder);
      }
    }
    if (filterBuilders.length > 0) {
      this.filters.push(new HasEdgeFilter(filterBuilders));
    }
    return this;
  }

  /**
   * Excludes faces that share an edge with the given scene object.
   * @param sceneObject - A scene object whose edges are matched against.
   */
  notHasEdge(sceneObject: ISceneObject): this;
  /**
   * Excludes faces that have edges matching all of the given edge filters.
   * @param edgeFilters - One or more edge filter builders. If all are satisfied, the face is excluded.
   */
  notHasEdge(...edgeFilters: EdgeFilterBuilder[]): this;
  notHasEdge(...args: any[]): this {
    const filterBuilders: EdgeFilterBuilder[] = [];
    for (const arg of args) {
      if (arg instanceof SceneObject) {
        this.filters.push(new NotHasEdgeFromSceneObjectFilter(arg));
      } else {
        filterBuilders.push(arg as EdgeFilterBuilder);
      }
    }
    if (filterBuilders.length > 0) {
      this.filters.push(new NotHasEdgeFilter(filterBuilders));
    }
    return this;
  }

  /**
   * Selects faces with exactly the given number of edges.
   * @param count - The exact number of edges to match.
   */
  edgeCount(count: number) {
    const filter = new EdgeCountFilter(count);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes faces with the given number of edges.
   * @param count - The number of edges to exclude.
   */
  notEdgeCount(count: number) {
    const filter = new NotEdgeCountFilter(count);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces that are entirely above the given plane (in the direction of its normal). Besides a
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

    const filter = new AboveFacePlaneFilter(planeRef, partial, offset);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects faces that are entirely below the given plane (opposite to its normal direction). Besides a
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

    const filter = new BelowFacePlaneFilter(planeRef, partial, offset);
    this.filters.push(filter);
    return this;
  }

  /**
   * Restricts the selection to faces originating from the given scene objects.
   * Recursive: passing a container picks up faces from its descendants.
   * @param sceneObjects - Scene objects whose faces (and faces of their sub-shapes) are matched against.
   */
  from(...sceneObjects: ISceneObject[]): this {
    // Part definitions coerce to their built default variant at argument
    // time, so the donor's geometry precedes the consuming select().
    const filter = new FromSceneObjectFilter<Face>(materializePartArgs(sceneObjects) as SceneObject[], "face");
    this.filters.push(filter);
    return this;
  }

  /**
   * Keeps the layer of faces farthest along a direction — every edge whose
   * center of mass lies at the maximum (within tolerance) along it. A box's
   * `farthest('z')` is its top face; chain order is evaluation
   * order, so `face().planar().farthest('z')` ranks only the planar faces.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  farthest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Face>(direction, { kind: 'farthest' }));
    return this;
  }

  /**
   * Excludes the layer of faces farthest along a direction.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  notFarthest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Face>(direction, { kind: 'farthest' }, true));
    return this;
  }

  /**
   * Keeps the layer of faces nearest along a direction — the minimum of the
   * center of mass along it (`nearest('z')` is the same as `farthest('-z')`).
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  nearest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Face>(direction, { kind: 'nearest' }));
    return this;
  }

  /**
   * Excludes the layer of faces nearest along a direction.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   */
  notNearest(direction: DirectionLike) {
    this.filters.push(new ExtremalFilter<Face>(direction, { kind: 'nearest' }, true));
    return this;
  }

  /**
   * Keeps the k-th layer of faces along a direction, counting layers of
   * equal center position from the near end (0-based); a negative index
   * counts from the far end, so `nth('z', -1)` is `farthest('z')`.
   * @param direction - `'x'`, `'y'`, `'z'`, `'-x'`, `'-y'`, `'-z'`, a vector, or an axis.
   * @param index - Layer index; out-of-range indices match nothing.
   */
  nth(direction: DirectionLike, index: number) {
    if (!Number.isInteger(index)) {
      throw new Error(`nth(direction, index): index must be an integer (got ${index})`);
    }
    this.filters.push(new ExtremalFilter<Face>(direction, { kind: 'nth', index }));
    return this;
  }

  /**
   * Keeps the largest faces — by area unless a measure is given — including
   * every face that ties with the largest.
   * @param measure - `'area'` (default) or `'radius'` for circular faces.
   */
  largest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Face>('largest', measure));
    return this;
  }

  /**
   * Excludes the largest faces (and their ties).
   * @param measure - `'area'` (default) or `'radius'`.
   */
  notLargest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Face>('largest', measure, true));
    return this;
  }

  /**
   * Keeps the smallest faces — by area unless a measure is given — including
   * every face that ties with the smallest.
   * @param measure - `'area'` (default) or `'radius'` for circular faces.
   */
  smallest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Face>('smallest', measure));
    return this;
  }

  /**
   * Excludes the smallest faces (and their ties).
   * @param measure - `'area'` (default) or `'radius'`.
   */
  notSmallest(measure: SizeMeasure = 'size') {
    this.filters.push(new MeasureExtremeFilter<Face>('smallest', measure, true));
    return this;
  }
}
