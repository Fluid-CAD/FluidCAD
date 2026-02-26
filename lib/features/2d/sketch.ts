import { Plane } from "../../math/plane.js";
import { Point2D } from "../../math/point.js";
import { GeometrySceneObject } from "./geometry.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Extrudable } from "../../helpers/types.js";

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

  getGeometriesWithOwner(): Map<Wire | Edge, GeometrySceneObject> {
    const children = this.getChildren() as GeometrySceneObject[];

    const result: Map<(Wire | Edge), GeometrySceneObject | null> = new Map();
    for (const child of children) {
      const shapes = child.getShapes();
      for (const shape of shapes) {
        result.set(shape as (Wire | Edge), child);
      }
    }

    return result;
  }

  getGeometries(): (Wire | Edge)[] {
    const children = this.getChildren() as GeometrySceneObject[];

    let wires: Array<Wire | Edge> = [];

    for (const child of children) {
      console.log("Sketch::getWires child:", child.getType(), child.parentId, this.id);
      if (child.parentId && child.parentId !== this.id) {
        continue;
      }

      if (child.isContainer()) {
        wires.push(...child.getChildShapes() as Wire[]);
      }
      else {
        const shapes = child.getShapes();
        for (const shape of shapes) {
          wires.push(shape as (Wire | Edge));
        }
      }
    }

    return wires;
  }

  override clone(): SceneObject[] {
    const planeClone = this.planeObj.clone();
    const sketch = new Sketch(planeClone[planeClone.length - 1] as PlaneObjectBase);

    const children = this.getChildren();
    const clonedChildren: GeometrySceneObject[] = [];
    for (const child of children) {
      const childCloneArr = child.clone();
      sketch.addChildObject(childCloneArr[childCloneArr.length - 1] as GeometrySceneObject);
      clonedChildren.push(...childCloneArr as GeometrySceneObject[]);
    }

    return [...planeClone, sketch, ...clonedChildren];
  }

  compareTo(other: Sketch): boolean {
    if (!(other instanceof Sketch)) {
      return false;
    }

    const thisChildren = this.getChildren();
    const otherChildren = other.getChildren();

    // This will probably lead to geometries getting compared twice during the renering process
    // TODO: consider using a compare cache to avoid redundant comparisons
    if (thisChildren.length !== otherChildren.length) {
      console.log(`Sketch::compareTo children length mismatch: ${thisChildren.length} vs ${otherChildren.length}`);
      console.log("This children:", thisChildren);
      console.log("Other children:", otherChildren);
      return false;
    }

    for (let i = 0; i < thisChildren.length; i++) {
      const thisChild = thisChildren[i];
      const otherChild = otherChildren[i];

      if (!thisChild.compareTo(otherChild)) {
        console.log(`Sketch::compareTo children at index ${i} do not match:`, thisChild, otherChild);
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "sketch";
  }

  serialize() {
    const plane = this.getPlane();
    return {
      currentPosition: plane.localToWorld(this.getLastPosition()),
      plane: this.planeObj.serialize(),
    }
  }

  override toString(): string {
    return `Sketch`;
  }
}
