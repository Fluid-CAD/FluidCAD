import { WireOps } from "../../oc/wire-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { Wire } from "../../common/wire.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class Offset extends ExtrudableGeometryBase {

  private _close: boolean = false;

  constructor(
    private distance: number,
    private removeOriginal: boolean = false,
    private sourceGeometries: SceneObject[] = null,
    targetPlane: PlaneObjectBase = null,
  ) {
    super(targetPlane);
  }

  close(): this {
    this._close = true;
    return this;
  }

  build() {
    if (this._close && this.removeOriginal) {
      throw new Error("Offset.close() cannot be used with removeOriginal");
    }

    let sourceObjects: Map<Edge, SceneObject>;
    if (this.sketch) {
      sourceObjects = this.sketch.getEdgesWithOwner();
    }
    else {
      sourceObjects = new Map<Edge, SceneObject>();
      for (const obj of this.sourceGeometries) {
        const shapes = obj.getShapes();
        for (const shape of shapes) {
          if (shape instanceof Edge) {
            sourceObjects.set(shape, obj);
          }
          else if (shape instanceof Wire) {
            for (const edge of shape.getEdges()) {
              sourceObjects.set(edge, obj);
            }
          }
        }
      }

      this.targetPlane.removeShapes(this);
    }

    const allEdges = Array.from(sourceObjects.keys());
    const wires: {
      wire: Wire,
      edges: Map<Edge, SceneObject>,
    }[] = [];

    const groups = WireOps.groupConnectedEdges(allEdges);
    for (const group of groups) {
      const wire = WireOps.makeWireFromEdges(group);
      wires.push({
        wire,
        edges: new Map(group.map(edge => [edge, sourceObjects.get(edge)]))
      });
    }

    let lastOffsetWire: Wire = null;

    for (const wireInfo of wires) {
      const isOpen = !wireInfo.wire.isClosed()
      const offsetWire = WireOps.offsetWire(wireInfo.wire, this.distance, isOpen);
      lastOffsetWire = offsetWire;
      const edges = offsetWire.getEdges();

      for (const edge of edges) {
        this.addShape(edge);
      }

      if (this._close && !offsetWire.isClosed()) {
        const originalStart = wireInfo.wire.getFirstVertex().toPoint();
        const originalEnd = wireInfo.wire.getLastVertex().toPoint();
        const offsetStart = offsetWire.getFirstVertex().toPoint();
        const offsetEnd = offsetWire.getLastVertex().toPoint();

        this.addShape(EdgeOps.makeLineEdge(originalEnd, offsetEnd));
        this.addShape(EdgeOps.makeLineEdge(offsetStart, originalStart));
      }

      if (this.removeOriginal) {
        for (const [edge, owner] of wireInfo.edges) {
          owner.removeShape(edge, this);
        }
      }
    }

    if (lastOffsetWire) {
      const plane = this.getPlane();
      const localStart = plane.worldToLocal(lastOffsetWire.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastOffsetWire.getLastVertex().toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));
    }
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.targetPlane) {
      deps.push(this.targetPlane);
    }
    if (this.sourceGeometries) {
      deps.push(...this.sourceGeometries);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const geometriesClone = this.sourceGeometries
      ? this.sourceGeometries.map(obj => remap.get(obj) || obj)
      : null;
    const copy = new Offset(this.distance, this.removeOriginal, geometriesClone, targetPlane);
    if (this._close) {
      copy._close = true;
    }
    return copy;
  }

  compareTo(other: Offset): boolean {
    if (!(other instanceof Offset)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    if ((this.sourceGeometries === null) !== (other.sourceGeometries === null)) {
      return false;
    }

    if (this.sourceGeometries && other.sourceGeometries) {
      if (this.sourceGeometries.length !== other.sourceGeometries.length) {
        return false;
      }

      for (let i = 0; i < this.sourceGeometries.length; i++) {
        const obj1 = this.sourceGeometries[i];
        const obj2 = other.sourceGeometries[i];
        if (!obj1.compareTo(obj2)) {
          return false;
        }
      }
    }

    return this.distance === other.distance
      && this.removeOriginal === other.removeOriginal
      && this._close === other._close;
  }

  getType(): string {
    return 'offset';
  }

  serialize() {
    return {
      distance: this.distance,
      removeOriginal: this.removeOriginal,
      close: this._close
    };
  }
}
