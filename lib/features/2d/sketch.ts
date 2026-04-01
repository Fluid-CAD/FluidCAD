import { Plane } from "../../math/plane.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Extrudable } from "../../helpers/types.js";
import { Geometry } from "../../oc/geometry.js";

export class Sketch extends SceneObject implements Extrudable {

  constructor(public planeObj: PlaneObjectBase) {
    super();
  }

  isContainer(): boolean {
    return true;
  }

  isExtrudable(): boolean {
    return true;
  }

  getPlane(): Plane {
    return this.planeObj.getPlane();
  }

  getStartPoint(): Point2D {
    const center = this.planeObj.getPlaneCenter();
    if (center) {
      const plane = this.getPlane();
      return plane.worldToLocal(center);
    }

    return new Point2D(0, 0);
  }

  getTangentAt(currentObj: GeometrySceneObject): Point2D | null {
    const children = this.getChildren() as GeometrySceneObject[];
    const previous = children.slice(0, children.indexOf(currentObj));
    let last = previous[previous.length - 1];
    while (last) {
      const tangent = last.getTangent();
      if (tangent) {
        return tangent;
      }

      previous.pop();
      last = previous[previous.length - 1];
    }

    return null;
  }

  getPositionAt(currentObj: GeometrySceneObject): Point2D {
    const children = this.getChildren() as GeometrySceneObject[];
    if (children.length === 1) {
      return this.getStartPoint();
    }

    const previous = children.slice(0, children.indexOf(currentObj));
    let last = previous[previous.length - 1];
    while (last) {
      const pos = last.getState('current-position') as Point2D;
      if (pos) {
        return pos;
      }

      previous.pop();
      last = previous[previous.length - 1];
    }

    return this.getStartPoint();
  }

  getLastPosition(): Point2D {
    const children = this.getChildren().slice() as GeometrySceneObject[];
    if (children.length === 0) {
      return this.getStartPoint();
    }

    while (true) {
      const last = children[children.length - 1];
      if (!last) {
        return this.getStartPoint();
      }

      const pos = last.getState('current-position') as Point2D;
      if (pos) {
        return pos;
      }
      children.pop();
    }
  }

  build() {
    this.planeObj.removeShapes(this)
  }

  getEdges(includeRemoved?: boolean): Edge[] {
    return [...this.getEdgesWithOwner(includeRemoved).keys()];
  }

  getEdgesWithOwner(includeRemoved = false): Map<Edge, GeometrySceneObject> {
    const children = this.getChildren() as GeometrySceneObject[];
    const result: Map<Edge, GeometrySceneObject> = new Map();

    for (const child of children) {
      const shapes = includeRemoved ? child.getAddedShapes() : child.getShapes();
      for (const shape of shapes) {
        if (shape instanceof Edge) {
          result.set(shape, child);
        } else if (shape instanceof Wire) {
          for (const edge of shape.getEdges()) {
            result.set(edge, child);
          }
        }
      }
    }

    return result;
  }

  getGeometriesWithOwner(includrRemoved = false): Map<Edge, GeometrySceneObject> {
    let geometries = this.getState('geometries') as Map<Edge, GeometrySceneObject>;
    if (geometries) {
      return geometries;
    }

    geometries = this.getEdgesWithOwner(includrRemoved);
    this.setState('geometries', geometries);
    return geometries;
  }

  getGeometries(includeRemoved?: boolean): Edge[] {
    return this.getEdges(includeRemoved);
  }

  override getDependencies(): SceneObject[] {
    return [this.planeObj];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const planeObj = (remap.get(this.planeObj) as PlaneObjectBase) || this.planeObj;
    return new Sketch(planeObj);
  }

  compareTo(other: Sketch): boolean {
    if (!(other instanceof Sketch)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.getOrder() !== other.getOrder()) {
      return false;
    }

    return true;
  }

  getTangent(): Point2D | null {
    let children = this.getChildren()?.slice() as GeometrySceneObject[];
    if (children.length === 0) {
      return null;
    }

    let last = children[children.length - 1];
    while (last) {
      if (!(last instanceof GeometrySceneObject)) {
        children.pop();
        last = children[children.length - 1];
        continue;
      }

      const tangent = last.getTangent();
      if (tangent) {
        console.log("Sketch::getTangent found tangent from child:", last.getName(), tangent);
        return tangent;
      }

      children.pop();
      last = children[children.length - 1];
    }

    return null;
  }

  getType(): string {
    return "sketch";
  }

  serialize() {
    const plane = this.getPlane();
    const tangent = this.getTangent();
    return {
      currentPosition: plane.localToWorld(this.getLastPosition()),
      currentTangent: tangent ? plane.localToWorld(tangent) : null,
      plane: this.planeObj.serialize(),
    }
  }

  override toString(): string {
    return `Sketch`;
  }
}
