import { PlaneLike } from "../../math/plane.js";
import { normalizePlane } from "../../helpers/normalize.js";
import { Face } from "../../common/shapes.js";
import { FilterBuilderBase } from "../filter-builder-base.js";
import { CircleFilter, NotCircleFilter } from "./circle-filter.js";
import { ConeFilter, NotConeFilter } from "./cone-filter.js";
import { CylinderCurveFilter, NotCylinderCurveFilter } from "./cylinder-curve.js";
import { CylinderFilter, NotCylinderFilter } from "./cylinder.js";
import { NotOnPlaneFilter, OnPlaneFilter } from "./on-plane.js";
import { NotParallelFilter, ParallelFilter } from "./parallel.js";
import { PlaneObject } from "../../features/plane.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";

export class FaceFilterBuilder extends FilterBuilderBase<Face> {
  constructor() {
    super();
  }

  onPlane(plane: PlaneLike | PlaneObjectBase, offset = 0) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      plane = normalizePlane(plane);

      if (offset) {
        plane= plane.offset(offset);
      }

      planeObj = new PlaneObject(plane);
    }

    const filter = new OnPlaneFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  notOnPlane(plane: PlaneLike | PlaneObjectBase, offset = 0) {
    if (!plane) {
      throw new Error('Plane is required');
    }

    let planeObj: PlaneObjectBase;

    if (plane instanceof PlaneObjectBase) {
      planeObj = plane;
    }
    else {
      plane = normalizePlane(plane);

      if (offset) {
        plane= plane.offset(offset);
      }

      planeObj = new PlaneObject(plane);
    }

    const filter = new NotOnPlaneFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  circle(radius?: number) {
    const filter = new CircleFilter(radius);
    this.filters.push(filter);
    return this;
  }

  notCircle(radius?: number) {
    const filter = new NotCircleFilter(radius);
    this.filters.push(filter);
    return this;
  }

  cylinder(radius?: number) {
    const filter = new CylinderFilter(radius);
    this.filters.push(filter);
    return this;
  }

  notCylinder(radius?: number) {
    const filter = new NotCylinderFilter(radius);
    this.filters.push(filter);
    return this;
  }

  cylinderCurve(radius?: number) {
    const filter = new CylinderCurveFilter(radius);
    this.filters.push(filter);
    return this;
  }

  notCylinderCurve(radius?: number) {
    const filter = new NotCylinderCurveFilter(radius);
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

    const filter = new ParallelFilter(planeObj);
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

    const filter = new NotParallelFilter(planeObj);
    this.filters.push(filter);
    return this;
  }

  cone() {
    const filter = new ConeFilter();
    this.filters.push(filter);
    return this;
  }

  notCone() {
    const filter = new NotConeFilter();
    this.filters.push(filter);
    return this;
  }
}

