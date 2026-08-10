import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { EdgeTargetArg, GeometrySceneObject } from "./2d/geometry.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Edge } from "../common/edge.js";
import { WireOps } from "../oc/wire-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { requireShapes } from "../common/operand-check.js";

export class Fillet2D extends GeometrySceneObject {
  private _targetObjects: EdgeTargetArg[] | null = null;

  constructor(private radius: number, ...targets: EdgeTargetArg[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
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
        requireShapes(target, `target ${i + 1}`, "fillet2d");
      }
    }
  }

  build(context: BuildSceneObjectContext) {
    // Resolve targets through lazy accessor objects (r.edge('top')) to the
    // real owning feature so removal and ownership stay correct.
    const edges: Map<Edge, SceneObject> = this.targetObjects === null
      ? this.sketch.getEdgesWithOwner()
      : this.resolveEdgeTargets(this.targetObjects);

    const allEdges = Array.from(edges.keys());

    const wires: {
      wire: Wire,
      edges: Map<Edge, SceneObject>,
    }[] = [];

    // Hand-drawn profiles routinely have corner endpoints that only nearly
    // meet. Exact-tolerance grouping treated such corners as disconnected and
    // silently skipped them — chain with the same size-proportional tolerance
    // the offset build uses (and the selection check verifies against).
    const connectTolerance = WireOps.connectTolerance(allEdges);
    const groups = WireOps.groupConnectedEdges(allEdges, connectTolerance);
    for (const group of groups) {
      const groupWires = WireOps.makeChainWires(group, connectTolerance);
      groupWires.forEach((wire, index) => {
        wires.push({
          wire,
          // The group's originals ride on the first wire only, so removal
          // strips each edge exactly once.
          edges: index === 0
            ? new Map(group.map(edge => [edge, edges.get(edge)]))
            : new Map(),
        });
      });
    }

    const strippedOwners = new Set<SceneObject>();

    for (const wireInfo of wires) {
      const inputEdges = Array.from(wireInfo.edges.keys());
      const filletedWire = FilletOps.fillet2d(wireInfo.wire, this.sketch.getPlane(), this.radius);
      const resultEdges = filletedWire.getEdges();

      // Surviving/trimmed edges keep their source roles; the new corner arcs
      // get 'fillet-arc' provenance, anything else unrecoverable is a trim.
      const unmatched = this.recoverEdgeRoles(resultEdges, inputEdges);
      for (const edge of unmatched) {
        if (EdgeQuery.getEdgeCurveType(edge) === 'circle') {
          edge.setProvenance('fillet-arc');
        } else {
          edge.setProvenance('trim-segment');
        }
      }

      for (const edge of resultEdges) {
        this.addShape(edge);
      }

      for (const [edge, owner] of wireInfo.edges) {
        // Remove through the sketch so every holder of the instance (real
        // owner and any lazy accessor mirror) records the removal.
        this.sketch.removeShape(edge, this);
        strippedOwners.add(owner);
      }
    }

    this.removeOrphanedMetaShapes(strippedOwners);
  }

  override getDependencies(): SceneObject[] {
    return GeometrySceneObject.sceneObjectTargets(this.targetObjects);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Fillet2D(this.radius, ...GeometrySceneObject.remapEdgeTargets(this.targetObjects, remap));
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

    return GeometrySceneObject.compareEdgeTargets(this.targetObjects, other.targetObjects);
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
