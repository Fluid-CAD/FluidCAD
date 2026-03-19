import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Edge } from "../common/edge.js";

export class Fillet2D extends GeometrySceneObject {
  private _targetObjects: GeometrySceneObject[] | null = null;

  constructor(private radius: number) {
    super();
  }

  target(...objects: SceneObject[]): this {
    this._targetObjects = objects as GeometrySceneObject[];
    return this;
  }

  get targetObjects(): GeometrySceneObject[] | null {
    return this._targetObjects;
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

  override getDependencies(): SceneObject[] {
    return this.targetObjects ? [...this.targetObjects] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Fillet2D(this.radius);
    if (this.targetObjects) {
      copy.target(...this.targetObjects.map(t => (remap.get(t) as GeometrySceneObject) || t));
    }
    return copy;
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
