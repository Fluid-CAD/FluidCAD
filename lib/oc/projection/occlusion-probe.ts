import type { IntCurvesFace_ShapeIntersector, TopoDS_Compound, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { FaceOps } from "../face-ops.js";
import { Vector3d } from "../../math/vector3d.js";
import { mmTol } from "../../units/tolerance.js";

/**
 * Where along a piece its sight lines are tested: five interior points,
 * near the middle first (the likeliest to settle a piece that is seen) and
 * all off the round fractions, so a probe does not land exactly under the
 * vertex or the edge of another feature built on the same grid.
 */
const PROBE_FRACTIONS = [0.47, 0.137, 0.863, 0.311, 0.689];

/**
 * How many of a piece's sight lines must plainly end on a face — with none
 * plainly clear — for the piece to count as covered. The rest may be
 * undecided (see {@link PointSight}).
 */
const MIN_COVERED_PROBES = 3;

/**
 * How far in front of a point a face has to be crossed to count: nearer than
 * this the crossing is the point's own surface, found again within the
 * kernel's intersection noise. Unit: mm.
 */
const MIN_DEPTH_MM = 1e-3;

/**
 * How squarely a sight line has to cross a face (the cosine between the
 * line and the face's normal) to count. A line running *in* a face — up the
 * riser of a step, from its foot — or grazing it at a silhouette crosses
 * nothing: such a face is edge-on from the viewer and covers no area.
 */
const MIN_CROSSING_COS = 1e-3;

/**
 * How far in front of the point the crossed face has to stand, measured
 * square to the face (the depth of the crossing times the cosine of its
 * angle). A point's own surface found again a little way along a grazing
 * line stays under this — the kernel's silhouettes of spline surfaces sit up
 * to about 0.01 mm inside the surface they belong to, and a line from such
 * a point leaves through that surface twice that far "in front" of it —
 * while a face that really covers the point is a wall thickness away.
 * Unit: mm.
 */
const MIN_STANDOFF_MM = 0.05;

/**
 * What one sight line says. `undecided`: nothing plainly in front, but the
 * line passes through the border of a face that stands in front — a seam or
 * an edge between two faces that both go on (cover), or the brink of a face
 * that ends there (no cover); a line cannot tell which.
 */
type PointSight = 'clear' | 'covered' | 'undecided';

/**
 * What the sight lines of a piece say: nothing plainly in front of it, a
 * face plainly in front of all of it, or some of each.
 */
export type PieceSight = 'clear' | 'covered' | 'mixed';

/**
 * A second opinion on visibility, by sight line: is there a face of the
 * model between a point and the viewer?
 *
 * The exact hidden-line algorithm (HLRBRep_Algo) decides visibility in the
 * projection, face by face, and gets it wrong where an occluding face has a
 * boundary edge lying exactly on its own silhouette: a pipe whose
 * supporting wall stops at the pipe's axis height left the stretch of the
 * wall's foot between the bore's outline and the pipe's outline visible
 * *under the pipe* (the CSWP tutorial part, top view). A ray has no such
 * weak spot — it is the test a depth buffer runs, and the reason the viewer
 * never showed that stretch.
 *
 * The probe only ever overrules the algorithm on plain evidence: a crossing
 * counts when it is inside a face (not on its boundary), square to it (not
 * running in it or grazing it) and clearly in front of the point (not the
 * point's own surface found again). Anything short of that leaves the
 * algorithm's answer standing.
 */
export class OcclusionProbe {
  private readonly compound: TopoDS_Compound;
  private readonly intersector: IntCurvesFace_ShapeIntersector;
  private readonly direction: [number, number, number];
  private readonly minDepth = mmTol(MIN_DEPTH_MM);
  private readonly minStandoff = mmTol(MIN_STANDOFF_MM);
  private readonly reach = mmTol(1e7);

  /** `shapes` are every shape of the view; `towardViewer` is the view plane's normal. */
  constructor(shapes: readonly TopoDS_Shape[], towardViewer: Vector3d) {
    const oc = getOC();
    this.compound = new oc.TopoDS_Compound();
    const builder = new oc.BRep_Builder();
    try {
      builder.MakeCompound(this.compound);
      for (const shape of shapes) {
        builder.Add(this.compound, shape);
      }
    } finally {
      builder.delete();
    }
    this.intersector = new oc.IntCurvesFace_ShapeIntersector();
    // 1e-7 is the kernel's classification floor (unit-free), as in OccHitTest.
    this.intersector.Load(this.compound, 1e-7);
    const unit = towardViewer.normalize();
    this.direction = [unit.x, unit.y, unit.z];
  }

  /** What the sight lines from `piece`'s interior points say — every point is tested. */
  sightOf(piece: TopoDS_Edge): PieceSight {
    const sights = this.probePoints(piece).map((point) => this.sightAt(point));
    const covered = sights.filter((sight) => sight === 'covered').length;
    if (covered === 0) {
      return 'clear';
    }
    return covered >= MIN_COVERED_PROBES && !sights.includes('clear') ? 'covered' : 'mixed';
  }

  /**
   * Whether a face plainly stands in front of `piece` along its length (the
   * `covered` of {@link sightOf}) — the only verdict that overrules the
   * hidden-line algorithm. Stops at the first clear sight line, so a piece
   * that is seen costs one ray.
   */
  isCoveredThroughout(piece: TopoDS_Edge): boolean {
    let covered = 0;
    for (const point of this.probePoints(piece)) {
      const sight = this.sightAt(point);
      if (sight === 'clear') {
        return false;
      }
      if (sight === 'covered') {
        covered++;
      }
    }
    return covered >= MIN_COVERED_PROBES;
  }

  /** Whether a face of the model plainly stands between `point` and the viewer. */
  isCovered(point: [number, number, number]): boolean {
    return this.sightAt(point) === 'covered';
  }

  private probePoints(piece: TopoDS_Edge): [number, number, number][] {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(piece);
    try {
      const first = adaptor.FirstParameter();
      const last = adaptor.LastParameter();
      return PROBE_FRACTIONS.map((fraction) => {
        const point = adaptor.Value(first + (last - first) * fraction);
        const xyz: [number, number, number] = [point.X(), point.Y(), point.Z()];
        point.delete();
        return xyz;
      });
    } finally {
      adaptor.delete();
    }
  }

  private sightAt(point: [number, number, number]): PointSight {
    const oc = getOC();
    const origin = new oc.gp_Pnt(point[0], point[1], point[2]);
    const dir = new oc.gp_Dir(this.direction[0], this.direction[1], this.direction[2]);
    const line = new oc.gp_Lin(origin, dir);
    try {
      this.intersector.Perform(line, this.minDepth, this.reach);
      if (!this.intersector.IsDone()) {
        return 'clear';
      }
      let sight: PointSight = 'clear';
      for (let i = 1; i <= this.intersector.NbPnt(); i++) {
        const state = this.intersector.State(i);
        const inside = state === oc.TopAbs_State.TopAbs_IN;
        if (!inside && state !== oc.TopAbs_State.TopAbs_ON) {
          continue;
        }
        const face = this.intersector.Face(i);
        try {
          const cos = this.crossingCos(face, this.intersector.UParameter(i), this.intersector.VParameter(i));
          if (cos >= MIN_CROSSING_COS && this.intersector.WParameter(i) * cos >= this.minStandoff) {
            if (inside) {
              return 'covered';
            }
            sight = 'undecided';
          }
        } finally {
          face.delete();
        }
      }
      return sight;
    } finally {
      line.delete();
      dir.delete();
      origin.delete();
    }
  }

  dispose(): void {
    this.intersector.delete();
    this.compound.delete();
  }

  /** The cosine of the angle between the sight line and the face's normal at (`u`, `v`); 0 where there is none. */
  private crossingCos(face: TopoDS_Face, u: number, v: number): number {
    const normal = FaceOps.outwardNormalRaw(face, { u, v });
    if (!normal) {
      return 0;
    }
    return Math.abs(normal.x * this.direction[0] + normal.y * this.direction[1] + normal.z * this.direction[2]);
  }
}
