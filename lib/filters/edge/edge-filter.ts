import { PlaneLike } from "../../math/plane.js";
import { normalizePlane } from "../../helpers/normalize.js";
import { Edge } from "../../common/shapes.js";
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

export class EdgeFilterBuilder extends FilterBuilderBase<Edge> {
  constructor() {
    super();
  }

  /**
   * Selects the edge at the given index.
   * @param index - Zero-based edge index.
   * @param shapes - The edge array to index into.
   * @param originalShapes - Optional original edge array before filtering.
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
   */
  notAtIndex(index: number, shapes: Edge[], originalShapes?: Edge[]) {
    const filter = new NotAtIndexFilter(index, shapes, originalShapes);
    this.filters.push(filter);
    return this;
  }

  /**
   * Selects edges that lie on the given plane.
   * @param plane - The reference plane.
   * @param offset - Optional distance to offset the plane before matching.
   * @param bothDirections - When true, also matches the plane offset in the opposite direction.
   */
  onPlane(plane: PlaneLike | PlaneObjectBase, offset = 0, bothDirections = false) {
    if (!plane) {
      throw new Error('Plane is required');
    }

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

    const filter = new OnPlaneFilter(planeObj, planeObj2);
    this.filters.push(filter);
    return this;
  }

  /**
   * Excludes edges that lie on the given plane.
   * @param plane - The reference plane.
   * @param offset - Optional distance to offset the plane before matching.
   * @param bothDirections - When true, also excludes the plane offset in the opposite direction.
   */
  notOnPlane(plane: PlaneLike | PlaneObjectBase, offset = 0, bothDirections = false) {
    if (!plane) {
      throw new Error('Plane is required');
    }

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

    const filter = new NotOnPlaneFilter(planeObj, planeObj2);
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

  static build() {
    return new EdgeFilterBuilder();
  }
}
