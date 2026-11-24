import type { BRepAdaptor_Curve, gp_Pnt, gp_Vec, TopoDS_Edge } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Plane } from "../../math/plane.js";
import { mmTol } from "../../units/tolerance.js";
import { BoxTree } from "./box-tree.js";
import { CoverMesh } from "./cover-mesh.js";

/**
 * How far in front of a point a face must stand, square to the face, to
 * hide it — the standoff of `OcclusionProbe`. A point's own surface and a
 * face it rests on stay under this; a face that really covers the point is
 * a wall thickness away. Unit: mm.
 */
export const MIN_STANDOFF_MM = 0.05;

/** How far a flattened piece may stray from its curve; crossings found on it are then refined on the curve. Unit: mm. */
const FLATTEN_CHORD_MM = 0.01;
/** A flattened curve is halved at most this many times per starting span. */
const FLATTEN_MAX_DEPTH = 7;
const FLATTEN_SPANS = 4;

/** Two points of a drawing this close are one. Unit: mm. */
const COINCIDENT_MM = 1e-6;

/** How far to the side of an edge its cover is read: near enough to be the edge's own side. Unit: mm. */
const SIDE_STEP_MM = 1e-4;

/** A stretch shorter than this is not drawn on its own — the cleanup's sliver rule. Unit: mm. */
const SLIVER_MM = 1e-3;

/** Where along a stretch its cover is read. */
const STRETCH_PROBES = [0.5, 0.2, 0.8];
/** A stretch whose probes disagree is halved at most this many times. */
const STRETCH_MAX_DEPTH = 16;

/**
 * Two flattened segments at less than this angle (its sine) and within
 * reach of each other run along each other rather than cross.
 */
const ALONG_SINE = 0.05;

const COVERED = 1;
const CLEAR = 0;
const UNSURE = 2;

/** The view's frame and the scratch kernel objects every evaluation reuses. */
export class ViewFrame {
  readonly origin: [number, number, number];
  readonly x: [number, number, number];
  readonly y: [number, number, number];
  readonly normal: [number, number, number];
  readonly point: gp_Pnt;
  readonly vector: gp_Vec;

  constructor(plane: Plane) {
    const oc = getOC();
    this.origin = [plane.origin.x, plane.origin.y, plane.origin.z];
    this.x = [plane.xDirection.x, plane.xDirection.y, plane.xDirection.z];
    this.y = [plane.yDirection.x, plane.yDirection.y, plane.yDirection.z];
    this.normal = [plane.normal.x, plane.normal.y, plane.normal.z];
    this.point = new oc.gp_Pnt();
    this.vector = new oc.gp_Vec();
  }

  /** A point of the view (`x`, `y`, `depth`) back in space. */
  toWorld(x: number, y: number, depth: number): [number, number, number] {
    return [
      this.origin[0] + x * this.x[0] + y * this.y[0] + depth * this.normal[0],
      this.origin[1] + x * this.x[1] + y * this.y[1] + depth * this.normal[1],
      this.origin[2] + x * this.x[2] + y * this.y[2] + depth * this.normal[2],
    ];
  }

  dispose(): void {
    this.point.delete();
    this.vector.delete();
  }
}

/**
 * One edge of a view, ready to be cut into what is seen and what is not:
 * the edge, its curve evaluated in the view frame, and a flattened copy on
 * which crossings are searched.
 */
export class ViewPiece {
  private readonly adaptor: BRepAdaptor_Curve;
  readonly first: number;
  readonly last: number;
  readonly isLine: boolean;
  /** The flattened piece: parameter, view `x`, `y` and depth of each vertex. */
  readonly u: number[] = [];
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly depth: number[] = [];
  /** Its length on the drawing. */
  readonly length: number;
  /** The last {@link evaluate}: `x`, `y`, depth and the drawn tangent. */
  readonly at = new Float64Array(5);

  constructor(readonly edge: TopoDS_Edge, private readonly frame: ViewFrame) {
    const oc = getOC();
    this.adaptor = new oc.BRepAdaptor_Curve(edge);
    this.first = this.adaptor.FirstParameter();
    this.last = this.adaptor.LastParameter();
    this.isLine = this.adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    this.flatten();
    let length = 0;
    for (let i = 1; i < this.u.length; i++) {
      length += Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.length = length;
  }

  /** The curve at `u` in the view frame, into {@link at}. */
  evaluate(u: number): void {
    const at = this.at;
    if (this.isLine) {
      const span = this.last - this.first;
      const f = (u - this.first) / span;
      const n = this.u.length - 1;
      at[0] = this.x[0] + (this.x[n] - this.x[0]) * f;
      at[1] = this.y[0] + (this.y[n] - this.y[0]) * f;
      at[2] = this.depth[0] + (this.depth[n] - this.depth[0]) * f;
      at[3] = (this.x[n] - this.x[0]) / span;
      at[4] = (this.y[n] - this.y[0]) / span;
      return;
    }
    const { point, vector, origin, x, y, normal } = this.frame;
    this.adaptor.D1(u, point, vector);
    const px = point.X() - origin[0];
    const py = point.Y() - origin[1];
    const pz = point.Z() - origin[2];
    const vx = vector.X();
    const vy = vector.Y();
    const vz = vector.Z();
    at[0] = px * x[0] + py * x[1] + pz * x[2];
    at[1] = px * y[0] + py * y[1] + pz * y[2];
    at[2] = px * normal[0] + py * normal[1] + pz * normal[2];
    at[3] = vx * x[0] + vy * x[1] + vz * x[2];
    at[4] = vx * y[0] + vy * y[1] + vz * y[2];
  }

  dispose(): void {
    this.adaptor.delete();
  }

  private position(u: number): [number, number, number] {
    const { point, origin, x, y, normal } = this.frame;
    this.adaptor.D0(u, point);
    const px = point.X() - origin[0];
    const py = point.Y() - origin[1];
    const pz = point.Z() - origin[2];
    return [
      px * x[0] + py * x[1] + pz * x[2],
      px * y[0] + py * y[1] + pz * y[2],
      px * normal[0] + py * normal[1] + pz * normal[2],
    ];
  }

  private flatten(): void {
    const push = (u: number, p: [number, number, number]) => {
      this.u.push(u);
      this.x.push(p[0]);
      this.y.push(p[1]);
      this.depth.push(p[2]);
    };
    const start = this.position(this.first);
    push(this.first, start);
    if (this.isLine) {
      push(this.last, this.position(this.last));
      return;
    }
    const chord = mmTol(FLATTEN_CHORD_MM);
    const refine = (u0: number, p0: [number, number, number], u1: number, p1: [number, number, number], depth: number) => {
      const um = (u0 + u1) / 2;
      const pm = this.position(um);
      const off = Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2);
      if (depth < FLATTEN_MAX_DEPTH && off > chord) {
        refine(u0, p0, um, pm, depth + 1);
        refine(um, pm, u1, p1, depth + 1);
      } else {
        // The midpoint is kept: it is paid for, and it quarters the error.
        push(um, pm);
        push(u1, p1);
      }
    };
    let previousU = this.first;
    let previous = start;
    for (let i = 1; i <= FLATTEN_SPANS; i++) {
      const u = this.first + ((this.last - this.first) * i) / FLATTEN_SPANS;
      const p = this.position(u);
      refine(previousU, previous, u, p, 0);
      previousU = u;
      previous = p;
    }
  }
}

/** The exact geometry's answer where the mesh has none. */
export interface ExactCover {
  /** Whether face `face` plainly stands between the point (in space) and the viewer. */
  isCovered(face: number, point: [number, number, number]): boolean;
}

/** A stretch of a piece and whether the model hides it. */
export type Stretch = { from: number; to: number; hidden: boolean };

/** How the pass went, for the curious and the benchmarks. */
export type VisibilityStats = { pieces: number; crossings: number; lookups: number; exactRays: number };

/**
 * Which stretches of each edge of a view are seen — the hiding pass of
 * hidden-line removal, done our way.
 *
 * The kernel's hiding pass compares every edge with every face in front of
 * it through exact intersections in the projection, and loses its footing
 * where edges land on each other there: a piston's ring grooves seen from
 * the side — forty faces — took it seventeen seconds, an engine of 29
 * solids four minutes. Yet the question is a simple one. Whether a point is
 * covered changes along an edge in two places only: where the edge crosses,
 * on the drawing, a crease or silhouette of the model that stands in front
 * of it — those hold the rim of every face's footprint and every step in
 * depth — and, when two bodies run into each other, where the edge enters
 * the other's surface. So:
 *
 * 1. every piece is cut where a crease or silhouette that may stand in
 *    front crosses it (flattened copies find the crossings, the curves
 *    themselves place them);
 * 2. each stretch between two cuts is read at a few points — is a face in
 *    front there? — and a stretch whose points disagree (an edge running
 *    into a body) is halved until they agree.
 *
 * **A point of an edge is hidden when the model covers the drawing on both
 * sides of it.** An edge is where surfaces meet or turn away, so it is
 * read a hair to each side, never on the edge itself: a silhouette has its
 * own surface on one side and is seen while the other is open; the foot of
 * a wall is seen while the floor beside it is; an edge lying exactly under
 * the rim of the face that covers it counts as seen, and the cleanup then
 * finds it under the rim's own line. Nothing needs to know which faces an
 * edge belongs to.
 *
 * Each side is read against the faces' meshes (`CoverMesh`), close by and a
 * mesh's error away. Where the two readings agree and are clear of the
 * mesh's error they are the answer; otherwise exact sight lines against the
 * faces found there settle it. The meshes do the volume, the exact geometry
 * has the last word.
 */
export class EdgeVisibility {
  readonly stats: VisibilityStats = { pieces: 0, crossings: 0, lookups: 0, exactRays: 0 };
  private readonly standoff = mmTol(MIN_STANDOFF_MM);
  private readonly coincident = mmTol(COINCIDENT_MM);
  private readonly chord = mmTol(FLATTEN_CHORD_MM);
  private readonly nearStep = mmTol(SIDE_STEP_MM);
  private readonly farStep: number;
  private segmentPiece = new Int32Array(0);
  private segmentIndex = new Int32Array(0);
  private segments: BoxTree = new BoxTree([], 0);

  /**
   * `cutters` are the creases and silhouettes of the whole view — what
   * bounds cover; `mesh` and `exact` answer for it. `maxBand` is the largest
   * mesh error of any face.
   */
  constructor(
    private readonly frame: ViewFrame,
    private readonly cutters: readonly ViewPiece[],
    private readonly mesh: CoverMesh,
    private readonly exact: ExactCover,
    maxBand: number,
  ) {
    // Far enough that a mesh's error cannot put the point on the wrong side of a rim.
    this.farStep = maxBand + mmTol(1e-3);
    let count = 0;
    for (const piece of cutters) {
      count += piece.u.length - 1;
    }
    this.segmentPiece = new Int32Array(count);
    this.segmentIndex = new Int32Array(count);
    const boxes = new Float64Array(count * 4);
    let s = 0;
    cutters.forEach((piece, p) => {
      for (let i = 0; i + 1 < piece.u.length; i++, s++) {
        this.segmentPiece[s] = p;
        this.segmentIndex[s] = i;
        boxes[4 * s] = Math.min(piece.x[i], piece.x[i + 1]);
        boxes[4 * s + 1] = Math.min(piece.y[i], piece.y[i + 1]);
        boxes[4 * s + 2] = Math.max(piece.x[i], piece.x[i + 1]);
        boxes[4 * s + 3] = Math.max(piece.y[i], piece.y[i + 1]);
      }
    });
    this.segments = new BoxTree(boxes, count);
  }

  /**
   * The stretches of `piece`, in order, each seen or hidden; neighbours of
   * one kind are already joined, so a piece nothing crosses answers one
   * stretch.
   */
  stretchesOf(piece: ViewPiece): Stretch[] {
    this.stats.pieces++;
    if (piece.length <= this.coincident) {
      // A line along the view direction draws nothing; it is not looked at.
      return [{ from: piece.first, to: piece.last, hidden: false }];
    }
    const range = piece.last - piece.first;
    const least = (this.coincident / piece.length) * range;
    const cuts = [piece.first];
    for (const u of this.crossingsOf(piece).sort((a, b) => a - b)) {
      if (u - cuts[cuts.length - 1] > least && piece.last - u > least) {
        cuts.push(u);
      }
    }
    cuts.push(piece.last);

    const stretches: Stretch[] = [];
    const add = (from: number, to: number, hidden: boolean) => {
      const previous = stretches[stretches.length - 1];
      if (previous && previous.hidden === hidden) {
        previous.to = to;
      } else {
        stretches.push({ from, to, hidden });
      }
    };
    const resolve = (from: number, to: number, depth: number) => {
      let hidden = 0;
      for (const fraction of STRETCH_PROBES) {
        if (this.isHidden(piece, from + (to - from) * fraction)) {
          hidden++;
        }
      }
      if (hidden === 0 || hidden === STRETCH_PROBES.length || depth >= STRETCH_MAX_DEPTH || to - from <= least) {
        add(from, to, hidden * 2 > STRETCH_PROBES.length);
        return;
      }
      const middle = (from + to) / 2;
      resolve(from, middle, depth + 1);
      resolve(middle, to, depth + 1);
    };
    for (let i = 0; i + 1 < cuts.length; i++) {
      resolve(cuts[i], cuts[i + 1], 0);
    }
    return this.withoutSlivers(piece, stretches);
  }

  /**
   * `stretches` with every one too short to draw given to its neighbour: at
   * a corner where several cuts fall within rounding of each other, the
   * hair between two of them reads as anything.
   */
  private withoutSlivers(piece: ViewPiece, stretches: Stretch[]): Stretch[] {
    if (stretches.length < 2) {
      return stretches;
    }
    const sliver = mmTol(SLIVER_MM);
    const drawn = (stretch: Stretch) => {
      piece.evaluate(stretch.from);
      const x = piece.at[0];
      const y = piece.at[1];
      piece.evaluate((stretch.from + stretch.to) / 2);
      const half = Math.hypot(piece.at[0] - x, piece.at[1] - y);
      return half * 2;
    };
    const kept: Stretch[] = [];
    stretches.forEach((stretch, index) => {
      const previous = kept[kept.length - 1];
      if (drawn(stretch) <= sliver && (previous || index + 1 < stretches.length)) {
        if (previous) {
          previous.to = stretch.to;
        } else {
          stretches[index + 1].from = stretch.from;
        }
      } else if (previous && previous.hidden === stretch.hidden) {
        previous.to = stretch.to;
      } else {
        kept.push(stretch);
      }
    });
    return kept;
  }

  /** The parameters of `piece` where a cutter that may stand in front crosses or touches it. */
  private crossingsOf(piece: ViewPiece): number[] {
    const crossings: number[] = [];
    for (let i = 0; i + 1 < piece.u.length; i++) {
      const ax = piece.x[i];
      const ay = piece.y[i];
      const rx = piece.x[i + 1] - ax;
      const ry = piece.y[i + 1] - ay;
      const rLength = Math.hypot(rx, ry);
      if (rLength === 0) {
        continue;
      }
      const du = piece.u[i + 1] - piece.u[i];
      const nearest = Math.min(piece.depth[i], piece.depth[i + 1]);
      this.segments.alongSegment(ax, ay, ax + rx, ay + ry, this.chord, (s) => {
        const other = this.cutters[this.segmentPiece[s]];
        if (other === piece) {
          return;
        }
        const j = this.segmentIndex[s];
        // A crease behind the piece bounds nothing that could hide it.
        if (Math.max(other.depth[j], other.depth[j + 1]) < nearest - this.standoff) {
          return;
        }
        const qx = other.x[j + 1] - other.x[j];
        const qy = other.y[j + 1] - other.y[j];
        const qLength = Math.hypot(qx, qy);
        if (qLength === 0) {
          return;
        }
        // Flattened curves miss each other by up to their chord error.
        const reach = piece.isLine && other.isLine ? this.coincident : this.chord;
        const wx = other.x[j] - ax;
        const wy = other.y[j] - ay;
        const cross = rx * qy - ry * qx;
        // Where the other's ends lie off the piece's line, signed.
        const offStart = (wx * ry - wy * rx) / rLength;
        const offEnd = ((wx + qx) * ry - (wy + qy) * rx) / rLength;
        const crossesLine = (offStart > reach && offEnd < -reach) || (offStart < -reach && offEnd > reach);
        if (!crossesLine && Math.abs(cross) <= ALONG_SINE * rLength * qLength) {
          // Running along each other — two lines on one carrier, or two
          // flattened copies of one arc, whose chords would cross at every
          // vertex: the cover may change only where the other ends.
          for (const end of [0, 1]) {
            if ((end === 0 && j !== 0) || (end === 1 && j + 2 !== other.u.length)) {
              continue;
            }
            if (Math.abs(end === 0 ? offStart : offEnd) > reach) {
              continue;
            }
            const ex = other.x[j + end] - ax;
            const ey = other.y[j + end] - ay;
            const f = (ex * rx + ey * ry) / (rLength * rLength);
            if (f >= -reach / rLength && f <= 1 + reach / rLength) {
              const start = piece.u[i] + du * Math.min(1, Math.max(0, f));
              crossings.push(piece.isLine ? start : this.footOf(piece, other.x[j + end], other.y[j + end], start, du));
              this.stats.crossings++;
            }
          }
          return;
        }
        if (cross === 0) {
          return;
        }
        const f = (wx * qy - wy * qx) / cross;
        const g = (wx * ry - wy * rx) / cross;
        if (f < -reach / rLength || f > 1 + reach / rLength || g < -reach / qLength || g > 1 + reach / qLength) {
          return;
        }
        this.stats.crossings++;
        const u = piece.u[i] + du * Math.min(1, Math.max(0, f));
        if (piece.isLine && other.isLine) {
          crossings.push(u);
          return;
        }
        const v = other.u[j] + (other.u[j + 1] - other.u[j]) * Math.min(1, Math.max(0, g));
        const refined = this.refine(piece, u, other, v, du);
        if (refined !== null) {
          crossings.push(refined);
          return;
        }
        // No crossing of the curves themselves: the other may end on the piece.
        const end = g < 0.5 ? 0 : 1;
        const isEnd = end === 0 ? j === 0 : j + 2 === other.u.length;
        crossings.push(isEnd ? this.footOf(piece, other.x[j + end], other.y[j + end], u, du) : u);
      });
    }
    return crossings;
  }

  /**
   * The crossing of two curves near (`u`, `v`), by Newton steps on the
   * curves themselves; null when the steps do not close in (curves that
   * only touch, or do not meet).
   */
  private refine(piece: ViewPiece, u: number, other: ViewPiece, v: number, span: number): number | null {
    const start = u;
    for (let step = 0; step < 10; step++) {
      piece.evaluate(u);
      other.evaluate(v);
      const fx = piece.at[0] - other.at[0];
      const fy = piece.at[1] - other.at[1];
      if (Math.hypot(fx, fy) <= this.coincident * 1e-2) {
        return Math.abs(u - start) <= 2 * Math.abs(span) ? u : null;
      }
      const [ax, ay, bx, by] = [piece.at[3], piece.at[4], -other.at[3], -other.at[4]];
      const det = ax * by - ay * bx;
      if (Math.abs(det) <= 1e-12 * Math.hypot(ax, ay) * Math.hypot(bx, by)) {
        return null;
      }
      u = Math.min(piece.last, Math.max(piece.first, u + (-fx * by + fy * bx) / det));
      v = Math.min(other.last, Math.max(other.first, v + (-ax * fy + ay * fx) / det));
    }
    return null;
  }

  /** The parameter of the point of `piece` nearest (`x`, `y`), searched from `u`. */
  private footOf(piece: ViewPiece, x: number, y: number, u: number, span: number): number {
    const start = u;
    for (let step = 0; step < 8; step++) {
      piece.evaluate(u);
      const dx = piece.at[0] - x;
      const dy = piece.at[1] - y;
      const speed2 = piece.at[3] * piece.at[3] + piece.at[4] * piece.at[4];
      if (speed2 === 0) {
        break;
      }
      // One Gauss–Newton step: the curvature term is nothing this close.
      const move = -(dx * piece.at[3] + dy * piece.at[4]) / speed2;
      u = Math.min(piece.last, Math.max(piece.first, u + move));
      if (Math.abs(move) * Math.sqrt(speed2) <= this.coincident * 1e-2) {
        break;
      }
    }
    return Math.abs(u - start) <= 2 * Math.abs(span) ? u : start;
  }

  /** Whether the model hides the point of `piece` at `u`: covered on both sides. */
  private isHidden(piece: ViewPiece, u: number): boolean {
    piece.evaluate(u);
    const [x, y, depth] = piece.at;
    let tx = piece.at[3];
    let ty = piece.at[4];
    const speed = Math.hypot(tx, ty);
    if (speed > 0) {
      tx /= speed;
      ty /= speed;
    } else {
      tx = 1;
      ty = 0;
    }
    // One side plainly open is enough to be seen, so both are read on the
    // meshes before the exact geometry is asked about either.
    const left = this.readSide(x, y, depth, -ty, tx, this.leftHits);
    if (left === CLEAR) {
      return false;
    }
    const right = this.readSide(x, y, depth, ty, -tx, this.rightHits);
    if (right === CLEAR) {
      return false;
    }
    return (left === COVERED || this.isSideCoveredExactly(x, y, depth, -ty, tx, this.leftHits))
      && (right === COVERED || this.isSideCoveredExactly(x, y, depth, ty, -tx, this.rightHits));
  }

  private readonly leftHits: number[] = [];
  private readonly rightHits: number[] = [];

  /**
   * What the meshes say of the side of (`x`, `y`) toward (`nx`, `ny`): read
   * close by and a mesh's error away, an answer only when both agree. The
   * faces found in front go into `hits`.
   */
  private readSide(x: number, y: number, depth: number, nx: number, ny: number, hits: number[]): number {
    const mesh = this.mesh;
    mesh.hits.length = 0;
    const near = this.read(x + nx * this.nearStep, y + ny * this.nearStep, depth);
    const far = this.read(x + nx * this.farStep, y + ny * this.farStep, depth);
    hits.length = 0;
    hits.push(...mesh.hits);
    return near === far ? near : UNSURE;
  }

  /** Whether one of `faces` plainly stands in front of the point just off (`x`, `y`) toward (`nx`, `ny`). */
  private isSideCoveredExactly(x: number, y: number, depth: number, nx: number, ny: number, faces: readonly number[]): boolean {
    const point = this.frame.toWorld(x + nx * this.nearStep, y + ny * this.nearStep, depth);
    for (const face of faces) {
      this.stats.exactRays++;
      if (this.exact.isCovered(face, point)) {
        return true;
      }
    }
    return false;
  }

  private read(x: number, y: number, depth: number): number {
    this.stats.lookups++;
    this.mesh.lookup(x, y, depth);
    return this.mesh.low > this.standoff ? COVERED : this.mesh.high < this.standoff ? CLEAR : UNSURE;
  }
}
