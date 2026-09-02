import { WireOps } from "../../oc/wire-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { Plane } from "../../math/plane.js";
import { Vertex } from "../../common/vertex.js";
import { Wire } from "../../common/wire.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { EdgeTargetArg, GeometrySceneObject } from "./geometry.js";
import { SelectSceneObject } from "../select.js";
import { mmTol } from "../../units/tolerance.js";

export class Offset extends ExtrudableGeometryBase {

  private _close: boolean = false;

  constructor(
    private distance: number,
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
    let sourceObjects: Map<Edge, SceneObject>;
    if (this.sketch) {
      // Explicit targets (objects, accessors, selections, edge filters)
      // narrow the offset; otherwise offset the whole sketch.
      sourceObjects = this.sourceGeometries?.length
        ? this.resolveEdgeTargets(this.sourceGeometries)
        : this.sketch.getEdgesWithOwner();
    }
    else {
      if (!this.sourceGeometries?.length) {
        throw new Error("Offset outside a sketch requires face or geometry targets");
      }

      sourceObjects = new Map<Edge, SceneObject>();
      const faces: Face[] = [];
      for (const obj of this.sourceGeometries) {
        if (!(obj instanceof SceneObject)) {
          throw new Error("Offset: edge filters are only supported inside a sketch");
        }
        const shapes = obj.getShapes();
        for (const shape of shapes) {
          if (shape instanceof Face) {
            faces.push(shape);
          }
          else if (shape instanceof Edge) {
            sourceObjects.set(shape, obj);
          }
          else if (shape instanceof Wire) {
            for (const edge of shape.getEdges()) {
              sourceObjects.set(edge, obj);
            }
          }
        }
      }

      if (faces.length > 0) {
        if (sourceObjects.size > 0) {
          throw new Error("Offset: face and edge targets cannot be mixed");
        }
        this.buildFromFaces(faces);
        this.consumeSelectionTargets();
        return;
      }

      this.targetPlane?.removeShapes(this);
    }

    const allEdges = Array.from(sourceObjects.keys());
    const wires: Wire[] = [];

    // Hand-drawn profiles routinely have endpoints that only nearly meet.
    // Exact-tolerance grouping split such profiles into fragments that each
    // offset to a side chosen by their own orientation — visibly
    // inconsistent. Chain edges with a tolerance proportional to their size.
    const connectTolerance = WireOps.connectTolerance(allEdges);
    const groups = WireOps.groupConnectedEdges(allEdges, connectTolerance);
    for (const group of groups) {
      wires.push(...WireOps.makeChainWires(group, connectTolerance));
    }

    let lastOffsetWire: Wire = null;
    const plane = this.getPlane();

    for (const wire of wires) {
      const offsetWire = WireOps.offsetWireOnPlane(wire, this.distance, wire.isClosed(), plane);
      lastOffsetWire = offsetWire;
      const edges = offsetWire.getEdges();

      for (const edge of edges) {
        edge.setProvenance('offset-of');
        this.addShape(edge);
      }

      if (this._close && !offsetWire.isClosed()) {
        const originalStart = wire.getFirstVertex().toPoint();
        const originalEnd = wire.getLastVertex().toPoint();
        const offsetStart = offsetWire.getFirstVertex().toPoint();
        const offsetEnd = offsetWire.getLastVertex().toPoint();

        const closeEnd = EdgeOps.makeLineEdge(originalEnd, offsetEnd);
        const closeStart = EdgeOps.makeLineEdge(offsetStart, originalStart);
        closeEnd.setProvenance('offset-of');
        closeStart.setProvenance('offset-of');
        this.addShape(closeEnd);
        this.addShape(closeStart);
      }
    }

    // Pen state is a legacy concept — writing it in a solved sketch would
    // hand getPositionAt a phantom cursor at the offset's end.
    if (lastOffsetWire && !this.sketch?.isSolvedMode()) {
      const localStart = plane.worldToLocal(lastOffsetWire.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastOffsetWire.getLastVertex().toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));
    }
  }

  /**
   * Face-target mode only: explicit select() targets are single-use, like
   * every other consumer's (shell, projection). Lazy accessors stay, and
   * edge-mode offsets (2D geometry) are never consumed.
   */
  private consumeSelectionTargets() {
    for (const obj of GeometrySceneObject.sceneObjectTargets(this.sourceGeometries)) {
      if (obj instanceof SelectSceneObject) {
        obj.removeShapes(this);
      }
    }
  }

  /**
   * Face-target mode: offsets the outlines of one or more coplanar faces on
   * the faces' own plane. All wires of a face offset together (region
   * semantics — a positive distance grows the outline, holes shrink), and the
   * result behaves like sketch geometry with the face plane as its plane, so
   * it can be extruded like any other profile.
   */
  private buildFromFaces(faces: Face[]) {
    if (this._close) {
      throw new Error("Offset.close() is not supported for face targets — face outlines are already closed");
    }

    const plane = faces[0].getPlane();
    for (const face of faces.slice(1)) {
      if (!plane.isCoplanarWith(face.getPlane(), mmTol(1e-6), 1e-6)) {
        throw new Error("Offset: face targets must be coplanar");
      }
    }
    this.setState('plane', plane);

    let lastWire: Wire = null;
    for (const face of faces) {
      const offsetWires = WireOps.offsetFaceOutline(face.getShape(), this.distance);
      for (const wire of offsetWires) {
        lastWire = wire;
        for (const edge of wire.getEdges()) {
          edge.setProvenance('offset-of');
          this.addShape(edge);
        }
      }
    }

    if (lastWire) {
      const localStart = plane.worldToLocal(lastWire.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastWire.getLastVertex().toPoint());
      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));
    }
  }

  /** In face-target mode the plane is derived from the faces, not a sketch. */
  override getPlane(): Plane {
    return (this.getState('plane') as Plane) ?? super.getPlane();
  }

  /** The SceneObject targets (selections, accessors), for edit-dialog seeding. */
  get targetObjects(): SceneObject[] {
    return GeometrySceneObject.sceneObjectTargets(this.sourceGeometries);
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
    const copy = new Offset(this.distance, geometriesClone, targetPlane);
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
      && this._close === other._close;
  }

  getType(): string {
    return 'offset';
  }

  serialize() {
    return {
      distance: this.distance,
      close: this._close
    };
  }
}
