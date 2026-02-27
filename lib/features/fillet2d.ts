import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Edge } from "../common/edge.js";

export class Fillet2D extends GeometrySceneObject {

  constructor(private targetObjects: GeometrySceneObject[], private radius: number) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let wires: Map<Wire | Edge, SceneObject> = new Map<Wire, SceneObject>();

    if (this.targetObjects === null) {
      wires = this.sketch.getGeometriesWithOwner();
    }
    else {
      for (const obj of this.targetObjects) {
        const wireShapes = obj.getShapes();
        for (const shape of wireShapes) {
          if (shape instanceof Wire) {
            wires.set(shape, obj);
          }
        }
      }
    }

    const result: Wire[] = [];

    console.log("Fillet2D::build wires:", wires.size);
    for (const [wire, owner] of wires) {
      const filletedWire = FilletOps.fillet2d(wire, this.sketch.getPlane(), this.radius);
      result.push(filletedWire);
      owner.removeShape(wire, this)
    }

    console.log("Fillet2D::build result wires:", result.length);

    this.addShapes(result);
  }

  override clone(): SceneObject[] {
    return []
  }

  compareTo(other: Fillet2D): boolean {
    if (!(other instanceof Fillet2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.radius !== other.radius) {
      return false;
    }

    const thisTargets = this.targetObjects || [];
    const otherTargets = other.targetObjects || [];

    if (thisTargets.length !== otherTargets.length) {
      return false;
    }

    for (let i = 0; i < thisTargets.length; i++) {
      if (!thisTargets[i].compareTo(otherTargets[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "fillet2d";
  }

  serialize() {
    return {
      radius: this.radius
    }
  }
}
