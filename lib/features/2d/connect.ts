import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { Point2D } from "../../math/point.js";
import { Plane } from "../../math/plane.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { GeometrySceneObject } from "./geometry.js";
import { Move } from "./move.js";

export type ConnectMode = 'line' | 'arc';

const CLOSED_EPSILON = 1e-9;

type BridgeAnchor = {
  local: Point2D;
  /** The real segment vertex the bridge attaches to, when one exists. */
  vertex: Vertex | null;
};

/**
 * Closes the current polyline: emits a single bridge edge from the last
 * segment's end back to the start of the polyline's first segment. The
 * first segment is found by walking the previous siblings backwards to the
 * last statement that does not use relative positioning — the segment after
 * an absolute move(), or an explicit-start segment (`line([a], [b])` forms,
 * the two-point arc). Chained statements (tLine, tArc, hLine, relative
 * moves, ...) derive their position from the cursor and are walked past.
 * Falls back to the sketch's start point when the whole sketch is one chain.
 */
export class Connect extends GeometrySceneObject {

  constructor(private mode: ConnectMode = 'line') {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const { from, to } = this.resolveBridgeEndpoints();

    const start = from.vertex ? EdgeOps.getVertexPoint(from.vertex) : plane.localToWorld(from.local);
    const end = to.vertex ? EdgeOps.getVertexPoint(to.vertex) : plane.localToWorld(to.local);

    // Already closed — a zero-length bridge aborts in OCCT.
    if (start.equals(end, CLOSED_EPSILON)) {
      return;
    }

    const startPos = plane.worldToLocal(start);
    const endPos = plane.worldToLocal(end);
    const bridgeDir = start.vectorTo(end);
    const chordTangent = endPos.subtract(startPos).normalize();

    let curve = null;
    let endTangent = chordTangent;

    if (this.mode === 'arc') {
      const tangent2d = this.sketch.getTangentAt(this).normalize();
      const edgeTangent = start.vectorTo(plane.localToWorld(startPos.add(tangent2d)));

      // If the incoming tangent is collinear with the bridge direction, an
      // arc degenerates into a semicircle. Fall back to a straight line.
      if (!edgeTangent.isParallelTo(bridgeDir)) {
        // Negate the tangent only if it points away from the endpoint
        // (would create a looping arc).
        const flip = edgeTangent.dot(bridgeDir) < 0;
        const tangent = flip ? edgeTangent.negate() : edgeTangent;
        curve = Geometry.makeArcFromTangent(start, end, tangent);

        // The chord makes equal angles with a tangent arc's start and end
        // tangents: the end tangent is the start tangent reflected across
        // the chord direction.
        const startTangent2d = flip ? tangent2d.multiplyScalar(-1) : tangent2d;
        const dot = startTangent2d.x * chordTangent.x + startTangent2d.y * chordTangent.y;
        endTangent = chordTangent.multiplyScalar(2 * dot).subtract(startTangent2d).normalize();
      }
    }

    if (!curve) {
      curve = Geometry.makeSegment(start, end);
    }

    // Share the segments' real vertices so the loop is topologically closed
    // — bridging authored coordinates instead can leave micro-gaps (an arc
    // end is projected onto its circle, landing off the authored point).
    const edge = from.vertex && to.vertex
      ? EdgeOps.makeEdgeFromCurveAndVertices(curve, from.vertex, to.vertex)
      : Geometry.makeEdgeFromCurve(curve);

    edge.setProvenance('bridge');

    this.setState('start', Vertex.fromPoint2D(startPos));
    this.setState('end', Vertex.fromPoint2D(endPos));
    this.setTangent(endTangent);
    this.addShape(edge);
    this.setCurrentPosition(endPos);
  }

  /**
   * The bridge runs from the last segment's end to the first segment's
   * start. The first segment is the one right after the nearest absolute
   * move(), or the nearest explicit-start segment, whichever comes last;
   * relative positioning statements (hMove and friends) stay inside the
   * chain and are walked past, closed shapes (circle, rect, ...) record no
   * segment endpoints and are skipped. The segments' own 'start'/'end'
   * states identify the endpoints — never the cursor position (arc(r) is
   * centered on the cursor, so neither of its endpoints is where the cursor
   * sits) — but each anchor then snaps to the segment's nearest real vertex,
   * whose built position can deviate from the authored one.
   */
  private resolveBridgeEndpoints(): { from: BridgeAnchor, to: BridgeAnchor } {
    const plane = this.sketch.getPlane();
    const siblings = this.sketch.getPreviousSiblings(this);
    let from: BridgeAnchor | null = null;
    let to: BridgeAnchor | null = null;

    for (let i = siblings.length - 1; i >= 0; i--) {
      const obj = siblings[i];
      if (!(obj instanceof GeometrySceneObject)) {
        continue;
      }

      if (obj instanceof Move) {
        // Relative moves (rMove semantics) stay inside the chain.
        if (obj.delta === null) {
          if (to === null) {
            // connect() right after a bare move(): close onto the cursor.
            const pos = obj.getState('current-position') as Point2D | undefined;
            to = pos ? { local: pos, vertex: null } : null;
          }
          break;
        }
        continue;
      }

      const start = obj.getState('start') as Vertex | undefined;
      const end = obj.getState('end') as Vertex | undefined;
      if (!start || !end) {
        continue;
      }

      if (from === null) {
        from = Connect.anchorAt(obj, end.toPoint2D(), plane);
      }
      to = Connect.anchorAt(obj, start.toPoint2D(), plane);

      if (Connect.hasExplicitStart(obj)) {
        break;
      }
    }

    return {
      from: from ?? { local: this.getCurrentPosition(), vertex: null },
      to: to ?? { local: this.sketch.getStartPoint(), vertex: null },
    };
  }

  /** The segment's real edge vertex nearest to the recorded endpoint. */
  private static anchorAt(obj: GeometrySceneObject, local: Point2D, plane: Plane): BridgeAnchor {
    const target = plane.localToWorld(local);

    let vertex: Vertex | null = null;
    let bestDistance = Infinity;
    for (const shape of obj.getShapes()) {
      if (!(shape instanceof Edge) || shape.isMetaShape() || shape.isGuideShape()) {
        continue;
      }
      for (const candidate of [EdgeOps.getFirstVertex(shape), EdgeOps.getLastVertex(shape)]) {
        const distance = EdgeOps.getVertexPoint(candidate).distanceTo(target);
        if (distance < bestDistance) {
          bestDistance = distance;
          vertex = candidate;
        }
      }
    }

    return { local, vertex };
  }

  /** Serialized explicit-start signal per feature form. */
  private static hasExplicitStart(obj: GeometrySceneObject): boolean {
    const payload = obj.serialize() as Record<string, unknown>;
    if (obj.getUniqueType() === 'arc') {
      return payload.startPoint !== undefined;
    }
    return payload.hasExplicitStart === true;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Connect(this.mode);
  }

  compareTo(other: Connect): boolean {
    if (!(other instanceof Connect)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.mode === other.mode;
  }

  getType(): string {
    return 'connect'
  }

  serialize() {
    return {
      mode: this.mode
    }
  }
}
