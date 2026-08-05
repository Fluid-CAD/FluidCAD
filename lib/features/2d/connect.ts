import { SceneObject } from "../../common/scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { Point2D } from "../../math/point.js";
import { Geometry } from "../../oc/geometry.js";
import { GeometrySceneObject } from "./geometry.js";
import { Move } from "./move.js";

export type ConnectMode = 'line' | 'arc';

const CLOSED_EPSILON = 1e-9;

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
    const { from: startPos, to: endPos } = this.resolveBridgeEndpoints();

    // Already closed — a zero-length bridge aborts in OCCT.
    if (startPos.equals(endPos, CLOSED_EPSILON)) {
      return;
    }

    const start = plane.localToWorld(startPos);
    const end = plane.localToWorld(endPos);
    const bridgeDir = start.vectorTo(end);
    const chordTangent = endPos.subtract(startPos).normalize();

    let edge = null;
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
        edge = Geometry.makeEdgeFromCurve(Geometry.makeArcFromTangent(start, end, tangent));

        // The chord makes equal angles with a tangent arc's start and end
        // tangents: the end tangent is the start tangent reflected across
        // the chord direction.
        const startTangent2d = flip ? tangent2d.multiplyScalar(-1) : tangent2d;
        const dot = startTangent2d.x * chordTangent.x + startTangent2d.y * chordTangent.y;
        endTangent = chordTangent.multiplyScalar(2 * dot).subtract(startTangent2d).normalize();
      }
    }

    if (!edge) {
      edge = Geometry.makeEdge(Geometry.makeSegment(start, end));
    }

    edge.setProvenance('bridge');

    this.setState('start', Vertex.fromPoint2D(startPos));
    this.setState('end', Vertex.fromPoint2D(endPos));
    this.setTangent(endTangent);
    this.addShape(edge);
    this.setCurrentPosition(endPos);
  }

  /**
   * The bridge runs from the last segment's recorded end to the first
   * segment's recorded start. The first segment is the one right after the
   * nearest absolute move(), or the nearest explicit-start segment,
   * whichever comes last; relative positioning statements (hMove and
   * friends) stay inside the chain and are walked past, closed shapes
   * (circle, rect, ...) record no segment endpoints and are skipped. The
   * segments' own 'start'/'end' states are the authority, never the cursor
   * position — arc(r) is centered on the cursor, so neither of its
   * endpoints is where the cursor sits.
   */
  private resolveBridgeEndpoints(): { from: Point2D, to: Point2D } {
    const siblings = this.sketch.getPreviousSiblings(this);
    let from: Point2D | null = null;
    let to: Point2D | null = null;

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
            to = obj.getState('current-position') as Point2D ?? null;
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
        from = end.toPoint2D();
      }
      to = start.toPoint2D();

      if (Connect.hasExplicitStart(obj)) {
        break;
      }
    }

    return {
      from: from ?? this.getCurrentPosition(),
      to: to ?? this.sketch.getStartPoint(),
    };
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
