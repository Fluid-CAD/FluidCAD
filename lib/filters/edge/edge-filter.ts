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

export class EdgeFilterBuilder extends FilterBuilderBase<Edge> {
  constructor() {
    super();
  }

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

  circle(diameter?: number) {
    const filter = new CircleFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  notCircle(diameter?: number) {
    const filter = new NotCircleFilter(diameter);
    this.filters.push(filter);
    return this;
  }

  arc(radius?: number) {
    const filter = new ArcFilter(radius);
    this.filters.push(filter);
    return this;
  }

  notArc(radius?: number) {
    const filter = new NotArcFilter(radius);
    this.filters.push(filter);
    return this;
  }

  line() {
    const filter = new LineFilter();
    this.filters.push(filter);
    return this;
  }

  notLine() {
    const filter = new NotLineFilter();
    this.filters.push(filter);
    return this;
  }

  static build() {
    return new EdgeFilterBuilder();
  }
}
