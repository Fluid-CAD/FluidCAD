import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { FaceOps } from "../oc/face-ops.js";
import { Face } from "../common/face.js";

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
    let sourceEdges: Map<Edge, SceneObject>;

    if (this._targetObjects === null) {
      sourceEdges = this.sketch.getGeometriesWithOwner();
    } else {
      sourceEdges = new Map<Wire | Edge, SceneObject>();
      for (const obj of this._targetObjects) {
        for (const shape of obj.getShapes()) {
          if (shape instanceof Edge) {
            sourceEdges.set(shape, obj);
          }
          else if (shape instanceof Wire) {
            for (const edge of shape.getEdges()) {
              sourceEdges.set(edge, obj);
            }
          }
        }
      }
    }

    const allEdges = Array.from(sourceEdges.keys()).filter(edge => edge.isClosed());
    const wires = allEdges.map(edge => WireOps.makeWireFromEdges([edge]));
    const faces = wires.map(wire => FaceOps.makeFaceWrapped(wire));

    const { newShapes } = BooleanOps.fuseFaces(faces);

    const newEdges = newShapes.flatMap((face: Face) => face.getEdges());

    for (const [edge, owner] of sourceEdges) {
      if (!allEdges.includes(edge)) {
        continue;
      }

      owner.removeShape(edge, this);
    }

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
