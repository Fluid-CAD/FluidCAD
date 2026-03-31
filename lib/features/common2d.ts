import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { FaceOps } from "../oc/face-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { Face } from "../common/face.js";
import { all } from "three/tsl";

export class Common2D extends GeometrySceneObject {
  private _targetObjects: GeometrySceneObject[] | null = null;
  private _keepOriginal: boolean = false;

  constructor(...targets: GeometrySceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  keepOriginal(value: boolean = true): this {
    this._keepOriginal = value;
    return this;
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

    const { newShapes } = BooleanOps.common(faces);

    const newEdges = newShapes.flatMap((face: Face) => face.getEdges());

    if (!this._keepOriginal) {
      for (const [wire, owner] of sourceEdges) {
        if (!allEdges.includes(wire)) {
          continue;
        }

        owner.removeShape(wire, this);
      }
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
    return new Common2D(...targets);
  }

  compareTo(other: Common2D): boolean {
    if (!(other instanceof Common2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this._keepOriginal !== other._keepOriginal) {
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
    return "common2d";
  }

  serialize() {
    return {};
  }
}
