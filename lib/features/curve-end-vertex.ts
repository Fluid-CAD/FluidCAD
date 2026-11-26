import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { AnchoredLazyVertex } from "./anchored-vertex.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { LazyVertex } from "./lazy-vertex.js";
import { anchorFromShape, buildOrthonormalFrame, FrameOptions, VertexAnchorSpec } from "./shape-anchor.js";

/** One end of a curve, in its walk: where it starts or where it ends. */
export type CurveEnd = 'start' | 'end';

/** The edge at one end of a curve, and which of the edge's own anchors is that end. */
type CurveEndAnchor = { edge: Edge; kind: CurveEnd };

/** A curve's two ends, as its builder leaves them in its state. */
export type CurveEnds = Record<CurveEnd, CurveEndAnchor>;

/**
 * The start or the end of a curve object (`c.start()`, `c.end()`), as an
 * anchor on the edge that holds it, so a consumer that wants more than the
 * point (the tangent a bridge leaves along) reads the edge too.
 *
 * An edge's own `start()` and `end()` follow the edge's canonical direction
 * (see `anchorFromShape`), which need not be the way the curve runs: a
 * straight piece drawn towards −X starts at its canonical end. The curve's
 * builder records, per end, the edge and which of its two anchors the end
 * is ({@link endsOf}); this vertex reads that once the curve has built.
 * Before then it reports the end it was asked for.
 */
export class CurveEndVertex extends AnchoredLazyVertex {

  /** State key under which a curve object keeps its {@link CurveEnds}. */
  static readonly STATE_KEY = 'curve-ends';

  constructor(
    private readonly curve: SceneObject,
    private readonly selectionName: string,
    private readonly end: CurveEnd,
  ) {
    super(
      new LazySelectionSceneObject(selectionName, parent => {
        const ends = parent.getState(CurveEndVertex.STATE_KEY) as CurveEnds | undefined;
        return ends ? [ends[end].edge] : [];
      }, curve),
      { kind: end },
    );
  }

  /**
   * The two ends of a curve given its edges in walk order. With several
   * edges, an end edge's free end is the one its neighbour does not share;
   * a single edge runs from its first vertex to its last.
   */
  static endsOf(edges: Edge[]): CurveEnds {
    const first = edges[0];
    const last = edges[edges.length - 1];
    return {
      start: { edge: first, kind: CurveEndVertex.anchorAt(first, CurveEndVertex.freeEnd(first, edges[1], first.getFirstPoint())) },
      end: { edge: last, kind: CurveEndVertex.anchorAt(last, CurveEndVertex.freeEnd(last, edges[edges.length - 2], last.getLastPoint())) },
    };
  }

  /** The end of `edge` that `neighbour` does not touch; `fallback` when there is no neighbour or it touches both (a closed pair). */
  private static freeEnd(edge: Edge, neighbour: Edge | undefined, fallback: Point): Point {
    if (!neighbour || neighbour === edge) {
      return fallback;
    }
    const ends = [edge.getFirstPoint(), edge.getLastPoint()];
    const reach = ends.map(point => Math.min(point.distanceTo(neighbour.getFirstPoint()), point.distanceTo(neighbour.getLastPoint())));
    if (reach[0] === reach[1]) {
      return fallback;
    }
    return reach[0] > reach[1] ? ends[0] : ends[1];
  }

  /** Which of the edge's own anchors, `start()` or `end()`, stands at `point`. */
  private static anchorAt(edge: Edge, point: Point): CurveEnd {
    const start = anchorFromShape(edge, { kind: 'start' }).origin;
    const end = anchorFromShape(edge, { kind: 'end' }).origin;
    return point.distanceTo(start) <= point.distanceTo(end) ? 'start' : 'end';
  }

  private recorded(): CurveEndAnchor | null {
    const ends = this.curve.getState(CurveEndVertex.STATE_KEY) as CurveEnds | undefined;
    return ends ? ends[this.end] : null;
  }

  override getAnchorSpec(): VertexAnchorSpec {
    return { kind: this.recorded()?.kind ?? this.end };
  }

  override build(): void {
    this.addShapes([Vertex.fromPoint(anchorFromShape(this.getAnchorShape(), this.getAnchorSpec()).origin)]);
  }

  override getAnchorFrame(options: FrameOptions = {}): Plane {
    const anchor = anchorFromShape(this.getAnchorShape(), this.getAnchorSpec());
    return buildOrthonormalFrame(anchor.origin, anchor.zDir, options);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new CurveEndVertex(remap.get(this.curve) ?? this.curve, this.selectionName, this.end);
  }

  override compareTo(other: LazyVertex): boolean {
    return other instanceof CurveEndVertex && this.end === other.end && super.compareTo(other);
  }
}
