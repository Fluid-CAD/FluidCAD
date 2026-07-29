import { WireOps } from "../../oc/wire-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { Wire } from "../../common/wire.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { EdgeTargetArg, GeometrySceneObject } from "./geometry.js";

export class Offset extends ExtrudableGeometryBase {

  private _close: boolean = false;

  constructor(
    private distance: number,
    private removeOriginal: boolean = false,
    private sourceGeometries: EdgeTargetArg[] = null,
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
      // Explicit targets (objects, accessors, selections, edge filters)
      // narrow the offset; otherwise offset the whole sketch.
      sourceObjects = this.sourceGeometries?.length
        ? this.resolveEdgeTargets(this.sourceGeometries)
        : this.sketch.getEdgesWithOwner();
    }
    else {
      sourceObjects = new Map<Edge, SceneObject>();
      for (const obj of this.sourceGeometries) {
        if (!(obj instanceof SceneObject)) {
          throw new Error("Offset: edge filters are only supported inside a sketch");
        }
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
    const plane = this.getPlane();
    const strippedOwners = new Set<SceneObject>();

    for (const wireInfo of wires) {
      const offsetWire = WireOps.offsetWireOnPlane(wireInfo.wire, this.distance, wireInfo.wire.isClosed(), plane);
      lastOffsetWire = offsetWire;
      const edges = offsetWire.getEdges();

      for (const edge of edges) {
        edge.setProvenance('offset-of');
        this.addShape(edge);
      }

      if (this._close && !offsetWire.isClosed()) {
        const originalStart = wireInfo.wire.getFirstVertex().toPoint();
        const originalEnd = wireInfo.wire.getLastVertex().toPoint();
        const offsetStart = offsetWire.getFirstVertex().toPoint();
        const offsetEnd = offsetWire.getLastVertex().toPoint();

        const closeEnd = EdgeOps.makeLineEdge(originalEnd, offsetEnd);
        const closeStart = EdgeOps.makeLineEdge(offsetStart, originalStart);
        closeEnd.setProvenance('offset-of');
        closeStart.setProvenance('offset-of');
        this.addShape(closeEnd);
        this.addShape(closeStart);
      }

      if (this.removeOriginal) {
        for (const [edge, owner] of wireInfo.edges) {
          if (this.sketch) {
            // Remove through the sketch so every holder of the instance
            // (real owner, lazy accessors, selections) records the removal.
            this.sketch.removeShape(edge, this);
          } else {
            owner.removeShape(edge, this);
          }
          strippedOwners.add(owner);
        }
      }
    }

    this.removeOrphanedMetaShapes(strippedOwners);

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
    deps.push(...GeometrySceneObject.sceneObjectTargets(this.sourceGeometries));
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const geometriesClone = this.sourceGeometries
      ? GeometrySceneObject.remapEdgeTargets(this.sourceGeometries, remap)
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
      if (!GeometrySceneObject.compareEdgeTargets(this.sourceGeometries, other.sourceGeometries)) {
        return false;
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
