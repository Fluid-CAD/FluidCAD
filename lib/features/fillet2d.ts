import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Edge } from "../common/edge.js";
import { WireOps } from "../oc/wire-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { requireShapes } from "../common/operand-check.js";

export class Fillet2D extends GeometrySceneObject {
  private _targetObjects: GeometrySceneObject[] | null = null;

  constructor(private radius: number, ...targets: SceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets as GeometrySceneObject[] : null;
  }

  get targetObjects(): GeometrySceneObject[] | null {
    return this._targetObjects;
  }

  override validate() {
    if (!this._targetObjects) {
      return;
    }
    for (let i = 0; i < this._targetObjects.length; i++) {
      requireShapes(this._targetObjects[i], `target ${i + 1}`, "fillet2d");
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

    const groups = WireOps.groupConnectedEdges(allEdges);
    for (const group of groups) {
      const wire = WireOps.makeWireFromEdges(group);
      wires.push({
        wire,
        edges: new Map(group.map(edge => [edge, edges.get(edge)]))
      });
    }

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

      for (const edge of wireInfo.edges.keys()) {
        // Remove through the sketch so every holder of the instance (real
        // owner and any lazy accessor mirror) records the removal.
        this.sketch.removeShape(edge, this);
      }
    }
  }

  override getDependencies(): SceneObject[] {
    return this.targetObjects ? [...this.targetObjects] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targets = this.targetObjects
      ? this.targetObjects.map(t => (remap.get(t) as GeometrySceneObject) || t)
      : [];
    return new Fillet2D(this.radius, ...targets);
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
