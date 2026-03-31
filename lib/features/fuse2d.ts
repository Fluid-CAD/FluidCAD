import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { FaceMaker } from "../core/2d/face-maker.js";

export class Fuse2D extends GeometrySceneObject {
  private _targetObjects: GeometrySceneObject[] | null = null;

  constructor(...targets: GeometrySceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  get targetObjects(): GeometrySceneObject[] | null {
    return this._targetObjects;
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.sketch.getPlane();
    let sourceWires: Map<Edge, SceneObject>;

    if (this._targetObjects === null) {
      sourceWires = this.sketch.getGeometriesWithOwner();
    } else {
      sourceWires = new Map<Wire | Edge, SceneObject>();
      for (const obj of this._targetObjects) {
        for (const shape of obj.getShapes()) {
          if (shape instanceof Wire || shape instanceof Edge) {
            sourceWires.set(shape, obj);
          }
        }
      }
    }

    const fusedWires = FaceMaker.fuseWires(Array.from(sourceWires.keys()), plane);

    for (const [edge, owner] of sourceWires) {
      owner.removeShape(edge, this);
    }

    const newEdges = fusedWires.flatMap(wire => wire.getEdges());

    this.addShapes(newEdges);
  }

  override getDependencies(): SceneObject[] {
    return this._targetObjects ? [...this._targetObjects] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targets = this._targetObjects
      ? this._targetObjects.map(t => (remap.get(t) as GeometrySceneObject) || t)
      : [];
    return new Fuse2D(...targets);
  }

  compareTo(other: Fuse2D): boolean {
    if (!(other instanceof Fuse2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    const thisTargets = this._targetObjects || [];
    const otherTargets = other._targetObjects || [];

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
    return "fuse2d";
  }

  serialize() {
    return {};
  }
}
