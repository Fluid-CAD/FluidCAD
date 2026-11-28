import type {
  Geom_Curve,
  gp_Ax2,
  HLRBRep_HLRToShape,
  HLRBRep_TypeOfResultingEdge,
  TopAbs_ShapeEnum,
  TopoDS_Edge,
  TopoDS_Shape,
} from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Convert } from "../convert.js";
import { Explorer } from "../explorer.js";
import { HiddenEdges } from "../hidden-edges.js";
import { OcclusionProbe } from "./occlusion-probe.js";
import { Plane } from "../../math/plane.js";
import { mmTol } from "../../units/tolerance.js";

/**
 * One shape of a view: the B-rep, and the edges of it the viewer leaves out
 * on top of the kernel's own seams — a solid's recorded render seams (the
 * joins inside one swept wall, `Shape.getRenderSeams()`).
 */
export interface ViewShape {
  shape: TopoDS_Shape;
  renderSeams?: readonly TopoDS_Shape[];
}

/**
 * Faces whose normals differ by less than this along an edge are tangent
 * there — the angle of the lib's smooth-edge cosine (`1 - 1e-6`, see
 * `EdgeConvexityOps`), so a drawing and the `smooth()` filter agree on what
 * a tangent edge is. Unit: radians.
 */
const TANGENT_ANGLE = Math.acos(1 - 1e-6);

/**
 * How far a piece may sit from an edge the viewer hides and still be that
 * edge. The pieces are trimmed stretches of the very curve, so the real
 * distance is rounding noise; unit: mm.
 */
const SAME_EDGE_TOLERANCE_MM = 1e-5;

/** Where along a piece it is compared with a hidden edge: both ends and three points between. */
const PIECE_PROBES = [0, 0.25, 0.5, 0.75, 1];

export interface HiddenLineOptions {
  /** Also return the sharp edges and outlines behind the model. */
  hidden?: boolean;
  /** Also return the visible smooth (G1) edges between faces. */
  tangent?: boolean;
}

/**
 * The edges of a view, as pieces in space. The caller owns every edge:
 * `dispose()` frees them all.
 */
export interface HiddenLineEdges {
  /** Sharp edges and outlines the viewer sees. */
  visible: TopoDS_Edge[];
  /** Smooth edges the viewer sees; empty unless asked for. */
  tangent: TopoDS_Edge[];
  /** Sharp edges and outlines behind the model; empty unless asked for. */
  hidden: TopoDS_Edge[];
  dispose(): void;
}

/**
 * What a view of one shape could draw, undecided: every piece is a stretch
 * of the model's own curve. `shape` is the copy the pieces were read from,
 * its edges' continuity recorded from the geometry. `dispose()` frees all.
 */
export interface ViewCurves {
  shape: TopoDS_Shape;
  /** Creases between faces. */
  sharp: TopoDS_Edge[];
  /** Silhouettes of curved faces for the view's direction. */
  outline: TopoDS_Edge[];
  /** Smooth edges between faces; empty unless asked for. */
  smooth: TopoDS_Edge[];
  dispose(): void;
}

/**
 * Hidden-line removal for a drawing view: which stretches of which edges a
 * viewer on the plane's normal side sees, looking back along the normal.
 *
 * OCCT's exact algorithm (HLRBRep_Algo) does the work; what is read from it
 * is deliberately its **3D** result (`CompoundOfEdges(type, visible, true)`):
 * each piece is a trimmed stretch of the model's own curve — the circle is
 * still a circle, the line a line — which the caller projects exactly. The
 * algorithm's 2D result is not used: it replaces every curve it cannot keep
 * (a circle seen edge-on, an ellipse seen tilted) with a 15-point polyline.
 *
 * The algorithm's groups, and where they go:
 *
 * - `Sharp` (a crease between two faces) and `OutLine` (a silhouette) are
 *   the drawing — `visible`, or `hidden` where the model covers them;
 * - `Rg1Line` (tangent-continuous: a fillet's border) and `RgNLine`
 *   (curvature-continuous: two stretches of one wall) are `tangent`, visible
 *   stretches only;
 * - `IsoLine` is never computed (`nbIso` 0).
 *
 * Two things the algorithm cannot be left to decide:
 *
 * **Which edges are smooth.** It sorts an edge into `Sharp` or a smooth
 * group by the continuity *recorded* on it, and takes an edge with no record
 * for a crease. A fillet feature records it; a boolean does not, so after a
 * fuse the border between a plate's flat side and its rounded corner — and
 * a pipe's seam — came out as creases, on `visible`. The view therefore
 * runs on a copy of each shape whose regularity is encoded from the
 * geometry (`BRepLib.EncodeRegularity`): the copy shares the curves and
 * surfaces but owns its topology, so the scene's shapes are never written
 * to.
 *
 * **Which edges nobody should see.** A periodic face's seam, a degenerated
 * edge and a recorded render seam are bookkeeping the viewer never draws
 * (`HiddenEdges`, `Shape.getRenderSeams()`), and a drawing shows nothing
 * the viewer hides. No group can be trusted to hold them: the algorithm
 * files one and the same seam under `RgNLine` in a view that looks straight
 * at it and under `Sharp` in a view where it lies on the outline, and under
 * `Sharp` everywhere once its continuity record is gone (after a later
 * boolean, and on the copy made here). It also returns new edges with no
 * link to their source. So the pieces of the crease and smooth groups are
 * matched by geometry against the unseen edges of the shape they came from:
 * one lying on such an edge along its whole length is dropped. Silhouettes
 * are never matched — a cylinder's seam can sit exactly on its outline, and
 * the outline is real.
 *
 * **Whether a piece under its own wall's junction is covered.** An edge
 * whose projection runs exactly along a boundary edge of the face in front
 * of it is taken to lie on that face's border, and the face then does not
 * hide it — even where the face goes on over it. A round post under a pipe
 * is the case: the post's foot circle lies exactly under the curve where
 * the post's wall runs into the pipe (both are on the post's cylinder, seen
 * edge-on), that curve is a border of the pipe's face, and the foot came
 * out visible *under the pipe*. (Flat walls do not trigger it.) So every
 * piece called visible is checked by a sight line (`OcclusionProbe`): one
 * that a face of the model plainly stands in front of, along its whole
 * length, is a hidden line. The algorithm cuts its pieces at every change
 * of visibility, so a piece is never split — it moves whole or stays.
 */
export class HiddenLineProjection {
  static project(shapes: readonly (TopoDS_Shape | ViewShape)[], plane: Plane, options: HiddenLineOptions = {}): HiddenLineEdges {
    const oc = getOC();
    const views = shapes.map((shape): ViewShape => ('shape' in shape ? shape : { shape }));
    const type = oc.HLRBRep_TypeOfResultingEdge;
    const edges: HiddenLineEdges = {
      visible: [],
      tangent: [],
      hidden: [],
      dispose() {
        Explorer.deleteAll([...this.visible, ...this.tangent, ...this.hidden]);
        this.visible = [];
        this.tangent = [];
        this.hidden = [];
      },
    };

    const [origin, disposeOrigin] = Convert.toGpPnt(plane.origin);
    const [normal, disposeNormal] = Convert.toGpDir(plane.normal);
    const [xDirection, disposeX] = Convert.toGpDir(plane.xDirection);
    // The view frame: Z is the plane's normal, pointing at the viewer.
    const frame = new oc.gp_Ax2(origin, normal, xDirection);
    const classified = views.map((view) => HiddenLineProjection.withEncodedRegularity(view.shape));
    const unseen = views.map((view) => new UnseenEdges(view));
    const probe = new OcclusionProbe(classified, plane.normal);
    try {
      HiddenLineProjection.withAlgo(classified, frame, true, (toShape) => {
        // Shape by shape: a piece is matched against the unseen edges of the
        // shape it came from, so one solid's crease lying along another's
        // seam is still drawn.
        classified.forEach((shape, index) => {
          const read = (kind: HLRBRep_TypeOfResultingEdge, visible: boolean) =>
            HiddenLineProjection.edgesOf(toShape, shape, kind, visible);
          /** A crease or smooth group, without the pieces of edges the viewer hides. */
          const readSeen = (kind: HLRBRep_TypeOfResultingEdge, visible: boolean) => unseen[index].strip(read(kind, visible));
          /**
           * The pieces the algorithm calls visible that a sight line confirms;
           * the ones the model plainly covers are sent to `covered`.
           */
          const confirmed = (pieces: TopoDS_Edge[], covered: TopoDS_Edge[]) => pieces.filter((piece) => {
            if (probe.isCoveredThroughout(piece)) {
              covered.push(piece);
              return false;
            }
            return true;
          });
          // A covered crease or outline is a hidden line; a covered smooth edge is nothing.
          const behind: TopoDS_Edge[] = [];
          const dropped: TopoDS_Edge[] = [];
          edges.visible.push(
            ...confirmed(readSeen(type.HLRBRep_Sharp, true), behind),
            ...confirmed(read(type.HLRBRep_OutLine, true), behind),
          );
          if (options.tangent) {
            edges.tangent.push(
              ...confirmed(readSeen(type.HLRBRep_Rg1Line, true), dropped),
              ...confirmed(readSeen(type.HLRBRep_RgNLine, true), dropped),
            );
          }
          if (options.hidden) {
            edges.hidden.push(...readSeen(type.HLRBRep_Sharp, false), ...read(type.HLRBRep_OutLine, false), ...behind);
          } else {
            dropped.push(...behind);
          }
          Explorer.deleteAll(dropped);
        });
      });
      return edges;
    } catch (error) {
      edges.dispose();
      throw error;
    } finally {
      probe.dispose();
      unseen.forEach((set) => set.dispose());
      Explorer.deleteAll(classified);
      frame.delete();
      disposeX();
      disposeNormal();
      disposeOrigin();
    }
  }

  /**
   * Everything a view of one shape could draw, with nothing decided about
   * what is seen: its creases, its silhouettes for the plane's direction
   * and — on request — its smooth edges, as pieces in space. The front half
   * of {@link project}: the algorithm computes the outlines (`Update`) and
   * the hiding pass is left out (`ShowAll`), which is where all of its time
   * goes on a model whose edges land on each other in the drawing.
   * Regularity is encoded and unseen edges are stripped as there. The
   * caller owns the result, the classified copy of the shape included.
   */
  static curves(view: ViewShape, plane: Plane, options: { tangent?: boolean } = {}): ViewCurves {
    const oc = getOC();
    const type = oc.HLRBRep_TypeOfResultingEdge;
    const [origin, disposeOrigin] = Convert.toGpPnt(plane.origin);
    const [normal, disposeNormal] = Convert.toGpDir(plane.normal);
    const [xDirection, disposeX] = Convert.toGpDir(plane.xDirection);
    const frame = new oc.gp_Ax2(origin, normal, xDirection);
    const classified = HiddenLineProjection.withEncodedRegularity(view.shape);
    const unseen = new UnseenEdges(view);
    const curves: ViewCurves = {
      shape: classified,
      sharp: [],
      outline: [],
      smooth: [],
      dispose() {
        Explorer.deleteAll([...this.sharp, ...this.outline, ...this.smooth, this.shape]);
        this.sharp = [];
        this.outline = [];
        this.smooth = [];
      },
    };
    try {
      HiddenLineProjection.withAlgo([classified], frame, false, (toShape) => {
        const read = (kind: HLRBRep_TypeOfResultingEdge) => HiddenLineProjection.edgesOf(toShape, classified, kind, true);
        curves.sharp = unseen.strip(read(type.HLRBRep_Sharp));
        curves.outline = read(type.HLRBRep_OutLine);
        if (options.tangent) {
          curves.smooth = [...unseen.strip(read(type.HLRBRep_Rg1Line)), ...unseen.strip(read(type.HLRBRep_RgNLine))];
        }
      });
      return curves;
    } catch (error) {
      curves.dispose();
      throw error;
    } finally {
      unseen.dispose();
      frame.delete();
      disposeX();
      disposeNormal();
      disposeOrigin();
    }
  }

  /**
   * A copy of `shape` with the continuity of every edge recorded from the
   * geometry of the faces it joins, so the hidden-line algorithm tells a
   * crease from a smooth join whatever built the shape. The copy shares the
   * shape's curves and surfaces and owns its topology — the records go on
   * the copy's edges, never the scene's. The caller deletes it.
   */
  private static withEncodedRegularity(shape: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const copier = new oc.BRepBuilderAPI_Copy(shape, false, false);
    try {
      const copy = copier.Shape();
      oc.BRepLib.EncodeRegularity(copy, TANGENT_ANGLE);
      return copy;
    } finally {
      copier.delete();
    }
  }

  /**
   * Runs the hidden-line algorithm on `shapes` seen in `frame` (its main
   * direction points at the viewer) and hands `fn` the result reader.
   * `hide` runs the visibility pass; without it every edge counts as
   * visible, which is all an outline computation needs.
   */
  static withAlgo<R>(shapes: readonly TopoDS_Shape[], frame: gp_Ax2, hide: boolean, fn: (toShape: HLRBRep_HLRToShape) => R): R {
    const oc = getOC();
    const projector = new oc.HLRAlgo_Projector(frame);
    const algo = new oc.HLRBRep_Algo();
    let toShape: HLRBRep_HLRToShape | null = null;
    try {
      for (const shape of shapes) {
        algo.Add(shape, 0);
      }
      algo.Projector(projector);
      algo.Update();
      if (hide) {
        algo.Hide();
      } else {
        algo.ShowAll();
      }
      toShape = new oc.HLRBRep_HLRToShape(algo);
      return fn(toShape);
    } finally {
      toShape?.delete();
      algo.delete();
      projector.delete();
    }
  }

  /**
   * The edges of one result group that come from `shape` (one of the shapes
   * the algorithm was given), each a typed copy the caller owns; degenerated
   * ones are dropped.
   */
  private static edgesOf(toShape: HLRBRep_HLRToShape, shape: TopoDS_Shape, kind: HLRBRep_TypeOfResultingEdge, visible: boolean): TopoDS_Edge[] {
    const oc = getOC();
    const compound = toShape.CompoundOfEdges(shape, kind, visible, true);
    try {
      if (compound.IsNull()) {
        return [];
      }
      const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
      return Explorer.withShapes(compound, EDGE, (raws) => {
        const edges: TopoDS_Edge[] = [];
        for (const raw of raws) {
          const edge = Explorer.toEdge(raw);
          if (oc.BRep_Tool.Degenerated(edge)) {
            edge.delete();
          } else {
            edges.push(edge);
          }
        }
        return edges;
      });
    } finally {
      compound.delete();
    }
  }
}

/** One edge the viewer hides, as the curve stretch a piece is measured against. */
type UnseenCurve = {
  curve: Geom_Curve;
  first: number;
  last: number;
  /** The stretch's end points, for a probe whose foot falls outside it. */
  ends: [number, number, number][];
  /** A box around the stretch, grown by the tolerance: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  box: number[];
  dispose(): void;
};

/**
 * The edges of one shape of a view that the viewer never draws — every
 * face's seams (`HiddenEdges`) and the shape's recorded render seams — and the test
 * of whether a piece of the hidden-line result is one of them. Degenerated
 * edges have no curve and no pieces, so they take no part.
 */
class UnseenEdges {
  private readonly curves: UnseenCurve[] = [];
  private readonly tolerance = mmTol(SAME_EDGE_TOLERANCE_MM);

  constructor(view: ViewShape) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const seen = new oc.TopTools_MapOfShape();
    try {
      Explorer.withShapes(view.shape, FACE, (raws) => {
        for (const raw of raws) {
          const face = Explorer.toFace(raw);
          try {
            for (const edge of HiddenEdges.ofFace(face)) {
              if (seen.Add(edge)) {
                this.add(edge);
              }
              edge.delete();
            }
          } finally {
            face.delete();
          }
        }
      });
      for (const seam of view.renderSeams ?? []) {
        if (seen.Add(seam)) {
          const edge = Explorer.toEdge(seam);
          this.add(edge);
          edge.delete();
        }
      }
    } finally {
      seen.delete();
    }
  }

  /** `pieces` without those lying on an unseen edge; the dropped ones are freed. */
  strip(pieces: TopoDS_Edge[]): TopoDS_Edge[] {
    if (this.curves.length === 0) {
      return pieces;
    }
    const kept: TopoDS_Edge[] = [];
    for (const piece of pieces) {
      if (this.covers(piece)) {
        piece.delete();
      } else {
        kept.push(piece);
      }
    }
    return kept;
  }

  dispose(): void {
    for (const curve of this.curves) {
      curve.dispose();
    }
    this.curves.length = 0;
  }

  private add(edge: TopoDS_Edge): void {
    const oc = getOC();
    if (oc.BRep_Tool.Degenerated(edge)) {
      return;
    }
    const handle = oc.BRep_Tool.Curve(edge, 0, 1);
    const curve = handle?.returnValue;
    if (!curve || curve.isNull()) {
      handle?.[Symbol.dispose]();
      return;
    }
    const { First: first, Last: last } = handle;
    const ends: [number, number, number][] = [];
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    // The box only has to hold the stretch: a line is its ends, a curve is sampled.
    const samples = 16;
    for (let i = 0; i <= samples; i++) {
      const point = curve.Value(first + ((last - first) * i) / samples);
      const xyz: [number, number, number] = [point.X(), point.Y(), point.Z()];
      point.delete();
      if (i === 0 || i === samples) {
        ends.push(xyz);
      }
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis], xyz[axis]);
        box[axis + 3] = Math.max(box[axis + 3], xyz[axis]);
      }
    }
    // A sampled arc bulges past its samples by at most the sagitta of one step.
    const reach = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    const margin = this.tolerance + reach / samples;
    for (let axis = 0; axis < 3; axis++) {
      box[axis] -= margin;
      box[axis + 3] += margin;
    }
    this.curves.push({ curve, first, last, ends, box, dispose: () => handle[Symbol.dispose]() });
  }

  /** Whether `piece` lies on one unseen edge along its whole length. */
  private covers(piece: TopoDS_Edge): boolean {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(piece);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      const probes = PIECE_PROBES.map((fraction): [number, number, number] => {
        const point = adaptor.Value(first + (last - first) * fraction);
        const xyz: [number, number, number] = [point.X(), point.Y(), point.Z()];
        point.delete();
        return xyz;
      });
      return this.curves.some((unseen) => probes.every((probe) => this.distance(probe, unseen) <= this.tolerance));
    } finally {
      adaptor.delete();
    }
  }

  /** The distance from `probe` to the unseen stretch; infinite once it is outside the stretch's box. */
  private distance(probe: [number, number, number], unseen: UnseenCurve): number {
    const { box } = unseen;
    for (let axis = 0; axis < 3; axis++) {
      if (probe[axis] < box[axis] || probe[axis] > box[axis + 3]) {
        return Infinity;
      }
    }
    const oc = getOC();
    // The nearest of the stretch's ends, and of the feet of the perpendiculars onto it.
    let nearest = Math.min(...unseen.ends.map((end) => Math.hypot(end[0] - probe[0], end[1] - probe[1], end[2] - probe[2])));
    const point = new oc.gp_Pnt(probe[0], probe[1], probe[2]);
    const projection = new oc.GeomAPI_ProjectPointOnCurve(point, unseen.curve, unseen.first, unseen.last);
    try {
      if (projection.NbPoints() > 0) {
        nearest = Math.min(nearest, projection.LowerDistance());
      }
    } finally {
      projection.delete();
      point.delete();
    }
    return nearest;
  }
}
