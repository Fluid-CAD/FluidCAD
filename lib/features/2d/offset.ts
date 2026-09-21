import { WireOps } from "../../oc/wire-ops.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { Plane } from "../../math/plane.js";
import { Wire } from "../../common/wire.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { EdgeTargetArg, GeometrySceneObject } from "./geometry.js";
import { SelectSceneObject } from "../select.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { mmTol } from "../../units/tolerance.js";
import { OffsetEdge, type OffsetEdgeRole } from "./offset-edge.js";

export class Offset extends ExtrudableGeometryBase {

  private _close: boolean = false;

  constructor(
    private distance: number,
    private sourceGeometries: EdgeTargetArg[] = null,
  ) {
    super();
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
    }

    // Statement order anchors the edge indices (`o.edge(i)`): the groups, and
    // the walk of every offset wire, start from the earliest drawn source.
    const allEdges = Offset.statementOrdered(sourceObjects);
    const wires: { wire: Wire; sources: Edge[] }[] = [];

    // Hand-drawn profiles routinely have endpoints that only nearly meet.
    // Exact-tolerance grouping split such profiles into fragments that each
    // offset to a side chosen by their own orientation — visibly
    // inconsistent. Chain edges with a tolerance proportional to their size.
    const connectTolerance = WireOps.connectTolerance(allEdges);
    const groups = WireOps.groupConnectedEdges(allEdges, connectTolerance);
    for (const group of groups) {
      for (const wire of WireOps.makeChainWires(group, connectTolerance)) {
        // The chain builder rebuilds its edges, so membership is geometric:
        // a source belongs to the wire its midpoint lies on.
        const members = wire.getEdges();
        const sources = group.filter(edge => {
          const mid = EdgeOps.getEdgeMidPoint(edge);
          return members.some(member => EdgeOps.distancePointToEdge(mid, member) <= connectTolerance);
        });
        wires.push({ wire, sources });
      }
    }

    const plane = this.getPlane();

    for (const { wire, sources } of wires) {
      const offsetWire = WireOps.offsetWireOnPlane(wire, this.distance, wire.isClosed(), plane);
      const { edges, reversed } = Offset.orderOffsetEdges(offsetWire, sources, this.distance);

      for (const edge of edges) {
        edge.setProvenance('offset-of');
        this.addShape(edge);
      }

      if (this._close && !offsetWire.isClosed()) {
        // The caps continue the walk: from the offset's last edge down to the
        // source, then from the source's other end back to the offset's start.
        const [sourceStart, sourceEnd] = reversed
          ? [wire.getLastVertex().toPoint(), wire.getFirstVertex().toPoint()]
          : [wire.getFirstVertex().toPoint(), wire.getLastVertex().toPoint()];
        const [offsetStart] = Offset.walkEndpoints(edges, 0);
        const [, offsetEnd] = Offset.walkEndpoints(edges, edges.length - 1);

        const closeEnd = EdgeOps.makeLineEdge(offsetEnd, sourceEnd);
        const closeStart = EdgeOps.makeLineEdge(sourceStart, offsetStart);
        closeEnd.setProvenance('offset-of');
        closeStart.setProvenance('offset-of');
        this.addShape(closeEnd);
        this.addShape(closeStart);
      }
    }
  }

  /** Source edges in statement order: the owner's order, then the edge's position among the owner's edges. */
  private static statementOrdered(sources: Map<Edge, SceneObject>): Edge[] {
    const ranks = new Map<Edge, [number, number]>();
    for (const [edge, owner] of sources) {
      ranks.set(edge, [owner.getOrder(), owner.getAddedShapes().indexOf(edge)]);
    }
    return [...sources.keys()].sort((a, b) => {
      const [aOrder, aIndex] = ranks.get(a)!;
      const [bOrder, bIndex] = ranks.get(b)!;
      return aOrder - bOrder || aIndex - bIndex;
    });
  }

  /**
   * The index rule. `Wire.getEdges()` starts a closed wire at its
   * lexicographically lowest midpoint — geometry, not source — so the walk is
   * re-anchored on the source: index 0 is the image of the earliest source
   * edge (statement order) that has one, and the indices continue in that
   * edge's own direction. An open offset walks from the end whose source
   * edge comes first. Rounding arcs are ordinary steps of the walk; a source
   * edge an inward offset swallowed simply has no image.
   */
  private static orderOffsetEdges(offsetWire: Wire, sources: Edge[], distance: number): { edges: Edge[]; reversed: boolean } {
    const edges = offsetWire.getEdges();
    if (edges.length < 2) {
      return { edges, reversed: false };
    }
    const images = edges.map(edge => Offset.sourceOf(edge, sources, distance));

    if (!offsetWire.isClosed()) {
      const first = images.find(source => source >= 0);
      const last = [...images].reverse().find(source => source >= 0);
      if (first !== undefined && last !== undefined && last < first) {
        return { edges: [...edges].reverse(), reversed: true };
      }
      return { edges, reversed: false };
    }

    let anchor = -1;
    for (const [i, source] of images.entries()) {
      if (source >= 0 && (anchor < 0 || source < images[anchor])) {
        anchor = i;
      }
    }
    if (anchor < 0) {
      return { edges, reversed: false };
    }
    const rotated = [...edges.slice(anchor), ...edges.slice(0, anchor)];
    // The list runs forward when the anchor's far end (the vertex it shares
    // with the next edge) is its end in the source edge's own direction.
    const [start, end] = Offset.walkEndpoints(rotated, 0);
    const forward = start.vectorTo(end).dot(Offset.chord(sources[images[anchor]])) >= 0;
    return forward
      ? { edges: rotated, reversed: false }
      : { edges: [rotated[0], ...rotated.slice(1).reverse()], reversed: true };
  }

  /** Which source edge an offset edge is the image of (statement index), or -1 for a rounding arc. */
  private static sourceOf(edge: Edge, sources: Edge[], distance: number): number {
    const type = EdgeQuery.getEdgeCurveType(edge);
    const mid = EdgeOps.getEdgeMidPoint(edge);
    let best = -1;
    let bestDistance = Infinity;
    for (const [i, source] of sources.entries()) {
      if (EdgeQuery.getEdgeCurveType(source) !== type || !Offset.isImage(edge, mid, source, type, distance)) {
        continue;
      }
      const separation = mid.distanceTo(EdgeOps.getEdgeMidPoint(source));
      if (separation < bestDistance) {
        best = i;
        bestDistance = separation;
      }
    }
    return best;
  }

  /** Parallel at the offset distance (lines), concentric at it (arcs), or on the offset curve (others). */
  private static isImage(edge: Edge, mid: Point, source: Edge, type: 'line' | 'circle' | 'other', distance: number): boolean {
    const tolerance = mmTol(1e-3) + Math.abs(distance) * 1e-6;
    if (type === 'line') {
      const axis = EdgeOps.edgeToAxis(source);
      const parallel = EdgeOps.edgeToAxis(edge).direction.cross(axis.direction).length() <= 1e-6;
      const separation = axis.origin.vectorTo(mid).cross(axis.direction).length();
      return parallel && Math.abs(separation - Math.abs(distance)) <= tolerance;
    }
    if (type === 'circle') {
      const own = EdgeQuery.getCircleDataFromEdge(edge);
      const theirs = EdgeQuery.getCircleDataFromEdge(source);
      return own.center.distanceTo(theirs.center) <= tolerance
        && Math.abs(Math.abs(own.radius - theirs.radius) - Math.abs(distance)) <= tolerance;
    }
    return Math.abs(EdgeOps.distancePointToEdge(mid, source) - Math.abs(distance)) <= tolerance + Math.abs(distance) * 1e-3;
  }

  private static chord(edge: Edge): Vector3d {
    return edge.getFirstVertex().toPoint().vectorTo(edge.getLastVertex().toPoint());
  }

  /**
   * The endpoints of edge `index` along the walk: an edge starts where the
   * previous one ends, so `o.edge(i).end()` is `o.edge(i + 1).start()`. The
   * first edge is turned to meet the second; a two-edge loop meets at both
   * ends and keeps its drawn orientation.
   */
  private static walkEndpoints(edges: Edge[], index: number): [Point, Point] {
    const tolerance = mmTol(1e-6);
    const ends = edges.slice(0, Math.max(index, 1) + 1)
      .map(edge => [edge.getFirstVertex().toPoint(), edge.getLastVertex().toPoint()]);
    const touchesSecond = (point: Point) => ends[1].some(other => other.distanceTo(point) <= tolerance);
    let [start, end] = ends[0];
    if (edges.length > 1 && touchesSecond(start) && !touchesSecond(end)) {
      [start, end] = [end, start];
    }
    for (let i = 1; i <= index; i++) {
      const [a, b] = ends[i];
      const previous = end;
      if (b.distanceTo(previous) <= tolerance && a.distanceTo(previous) > tolerance) {
        [start, end] = [b, a];
      } else {
        [start, end] = [a, b];
      }
    }
    return [start, end];
  }

  /** The offset's real edges in index order — the order the build added them. */
  private offsetEdges(): Edge[] {
    return this.getAddedShapes().filter((shape): shape is Edge => shape instanceof Edge && !shape.isMetaShape());
  }

  /** The lazy selection behind `o.edge(i)`: that one edge, or nothing when the index is out of range. */
  edgeShapes(index: number): Edge[] {
    const edge = this.offsetEdges()[index];
    return edge ? [edge] : [];
  }

  /** The index of one of this offset's edges, or -1 for a foreign shape. */
  edgeIndexOf(edge: Edge): number {
    return this.offsetEdges().indexOf(edge);
  }

  /** World position of a named point of edge `index` — the `o.edge(i).start()` read. */
  edgePoint(index: number, role: OffsetEdgeRole): Point {
    const edges = this.offsetEdges();
    const edge = edges[index];
    if (!edge) {
      const count = edges.length === 0 ? 'no edges yet (read it after the sketch is built)' : `${edges.length} edge${edges.length === 1 ? '' : 's'}`;
      throw new Error(`offset edge ${index} does not exist — this offset has ${count}`);
    }
    if (role === 'center') {
      const type = EdgeQuery.getEdgeCurveType(edge);
      if (type !== 'circle') {
        throw new Error(`offset edge ${index} is a ${type === 'line' ? 'line' : 'curve'}, not an arc — .center() needs an arc edge`);
      }
      return EdgeQuery.getCircleDataFromEdge(edge).center;
    }
    const [start, end] = Offset.walkEndpoints(edges, index);
    return role === 'start' ? start : end;
  }

  /**
   * `edge(i)` on an offset is also a point source: `o.edge(i).start()` /
   * `.end()` / `.center()` name the edge's points for consumers outside the
   * sketch (D9 index rule — see `orderOffsetEdges`). Role lookups keep the
   * uniform accessor's behaviour.
   */
  override edge(index: number): OffsetEdge;
  override edge(roleOrIndex: string | number, roleIndex?: number): LazySelectionSceneObject;
  override edge(roleOrIndex: string | number, roleIndex?: number): LazySelectionSceneObject {
    if (typeof roleOrIndex === 'number') {
      return new OffsetEdge(this.generateUniqueName(`edge-${roleOrIndex}`), this, roleOrIndex);
    }
    return super.edge(roleOrIndex, roleIndex);
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

    for (const face of faces) {
      const offsetWires = WireOps.offsetFaceOutline(face.getShape(), this.distance);
      for (const wire of offsetWires) {
        for (const edge of wire.getEdges()) {
          edge.setProvenance('offset-of');
          this.addShape(edge);
        }
      }
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
    return GeometrySceneObject.sceneObjectTargets(this.sourceGeometries);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const geometriesClone = this.sourceGeometries
      ? GeometrySceneObject.remapEdgeTargets(this.sourceGeometries, remap)
      : null;
    const copy = new Offset(this.distance, geometriesClone);
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
