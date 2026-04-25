import { PlaneLike } from "../../math/plane.js";
import { normalizePlane } from "../../helpers/normalize.js";
import { Face } from "../../common/shapes.js";
import { FilterBuilderBase } from "../filter-builder-base.js";
import { CircleFilter, NotCircleFilter } from "./circle-filter.js";
import { ConeFilter, NotConeFilter } from "./cone-filter.js";
import { CylinderCurveFilter, NotCylinderCurveFilter } from "./cylinder-curve.js";
import { CylinderFilter, NotCylinderFilter } from "./cylinder.js";
import { TorusFilter, NotTorusFilter } from "./torus-filter.js";
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
import { EdgeFilterBuilder } from "../edge/edge-filter.js";
import { SceneObject } from "../../common/scene-object.js";
import { ISceneObject } from "../../core/interfaces.js";

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
   * Selects faces that lie on the given plane.
   * @param plane - The reference plane.
   * @param offset - Optional distance to offset the plane before matching.
   */
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

  /**
   * Excludes faces that lie on the given plane.
   * @param plane - The reference plane.
   * @param offset - Optional distance to offset the plane before matching.
   */
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
   * Restricts the selection to faces originating from the given scene objects.
   * Recursive: passing a container picks up faces from its descendants.
   * @param sceneObjects - Scene objects whose faces (and faces of their sub-shapes) are matched against.
   */
  from(...sceneObjects: ISceneObject[]): this {
    const filter = new FromSceneObjectFilter<Face>(sceneObjects as SceneObject[], "face");
    this.filters.push(filter);
    return this;
  }
}

