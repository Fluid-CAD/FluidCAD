import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { EdgeTargetArg, GeometrySceneObject } from "./2d/geometry.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Face } from "../common/face.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { requireShapes } from "../common/operand-check.js";

export class Common2D extends GeometrySceneObject {
  private _targetObjects: EdgeTargetArg[] | null = null;
  private _keepOriginal: boolean = false;

  constructor(...targets: EdgeTargetArg[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  keepOriginal(value: boolean = true): this {
    this._keepOriginal = value;
    return this;
  }

  get targetObjects(): EdgeTargetArg[] | null {
    return this._targetObjects;
  }

  override validate() {
    if (!this._targetObjects) {
      return;
    }
    for (let i = 0; i < this._targetObjects.length; i++) {
      const target = this._targetObjects[i];
      if (target instanceof SceneObject) {
        requireShapes(target, `operand ${i + 1}`, "common2d");
      }
    }
  }

  build(context: BuildSceneObjectContext) {
    let sourceEdges: Map<Edge, SceneObject>;

    if (this._targetObjects === null) {
      sourceEdges = this.sketch.getGeometriesWithOwner();
    } else {
      sourceEdges = this.resolveEdgeTargets(this._targetObjects);
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

    const { newShapes } = BooleanOps.common(faces);

    if (newShapes.length === 0) {
      return;
    }

    const newEdges = newShapes.flatMap((face: Face) => face.getEdges());

    if (!this._keepOriginal) {
      for (const [edge, owner] of sourceEdges) {
        if (!processedOwners.has(owner)) {
          continue;
        }
        // Remove through the sketch so every holder of the instance (real
        // owner, lazy accessors, select statements) records the removal.
        this.sketch.removeShape(edge, this);
      }
    }

    // Surviving stretches keep their source roles; new pieces are boolean cuts.
    const unmatched = this.recoverEdgeRoles(newEdges, Array.from(sourceEdges.keys()));
    for (const edge of unmatched) {
      edge.setProvenance('boolean-result');
    }

    this.addShapes(newEdges);
  }

  override getDependencies(): SceneObject[] {
    return GeometrySceneObject.sceneObjectTargets(this._targetObjects);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Common2D(...GeometrySceneObject.remapEdgeTargets(this._targetObjects, remap));
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

    return GeometrySceneObject.compareEdgeTargets(this._targetObjects, other._targetObjects);
  }

  getType(): string {
    return "common2d";
  }

  serialize() {
    return {};
  }
}
