import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Face } from "../common/face.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { requireShapes } from "../common/operand-check.js";

export class Fuse2D extends GeometrySceneObject {
  private _targetObjects: GeometrySceneObject[] | null = null;

  constructor(...targets: GeometrySceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  get targetObjects(): GeometrySceneObject[] | null {
    return this._targetObjects;
  }

  override validate() {
    if (!this._targetObjects) {
      return;
    }
    for (let i = 0; i < this._targetObjects.length; i++) {
      requireShapes(this._targetObjects[i], `operand ${i + 1}`, "fuse2d");
    }
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

    const plane = this.sketch.getPlane();

    // Group edges by owner
    const ownerToEdges = new Map<SceneObject, Edge[]>();
    for (const [edge, owner] of sourceEdges) {
      if (!ownerToEdges.has(owner)) {
        ownerToEdges.set(owner, []);
      }
      ownerToEdges.get(owner)!.push(edge);
    }

    // Convert each owner's edges to faces via FaceMaker2
    const faces: Face[] = [];
    const processedOwners = new Set<SceneObject>();
    for (const [owner, edges] of ownerToEdges) {
      const ownerFaces = FaceMaker2.getRegions(edges, plane);
      if (ownerFaces.length > 0) {
        faces.push(...ownerFaces);
        processedOwners.add(owner);
      }
    }

    if (faces.length === 0) {
      return;
    }

    const { newShapes } = BooleanOps.fuseFaces(faces);

    if (newShapes.length === 0) {
      return;
    }

    const newEdges = newShapes.flatMap((face: Face) => face.getEdges());

    for (const [edge, owner] of sourceEdges) {
      if (!processedOwners.has(owner)) {
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
