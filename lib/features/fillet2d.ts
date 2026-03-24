import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { FilletOps } from "../oc/fillet-ops.js";
import { Edge } from "../common/edge.js";
import { WireOps } from "../oc/wire-ops.js";

export class Fillet2D extends GeometrySceneObject {
  private _targetObjects: GeometrySceneObject[] | null = null;

  constructor(private radius: number, ...targets: SceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets as GeometrySceneObject[] : null;
  }

  get targetObjects(): GeometrySceneObject[] | null {
    return this._targetObjects;
  }

  build(context: BuildSceneObjectContext) {
    let edges: Map<Edge, SceneObject> = new Map<Wire, SceneObject>();

    if (this.targetObjects === null) {
      edges = this.sketch.getEdgesWithOwner();
    }
    else {
      for (const obj of this.targetObjects) {
        const wireShapes = obj.getShapes();
        for (const shape of wireShapes) {
          if (shape instanceof Edge) {
            edges.set(shape, obj);
          }
          else if (shape instanceof Wire) {
            for (const edge of shape.getEdges()) {
              edges.set(edge, obj);
            }
          }
        }
      }
    }

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
      const filletedWire = FilletOps.fillet2d(wireInfo.wire, this.sketch.getPlane(), this.radius);
      const edges = filletedWire.getEdges();

      for (const edge of edges) {
        this.addShape(edge);
      }

      for (const [edge, owner] of wireInfo.edges) {
        owner.removeShape(edge, this);
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
