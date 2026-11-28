import { BoxTree } from "./box-tree.js";

/**
 * The faces of a view as triangles in the view's own frame — `x`, `y` on
 * the drawing plane, `depth` toward the viewer — and the one question a
 * drawing asks of them: does a face stand in front of this point? Pure
 * TypeScript; the parallel sight lines of an orthographic view make it a
 * point lookup in the plane, no ray casting.
 *
 * "In front" is measured square to the face — the distance from the point
 * to the triangle's plane — not along the sight line. A surface seen nearly
 * edge-on rises steeply along the line while staying a hair from the point:
 * that is the point's own surface next to its silhouette, not a cover.
 *
 * A mesh is an approximation, and the answer says so: each face comes with
 * the distance its triangles may stray from it (`band`), and a lookup
 * answers the range the nearest cover lies in rather than one number. The
 * caller trusts an answer that clears its threshold by the whole range and
 * asks the exact geometry otherwise.
 */
export class CoverMesh {
  private readonly grid: BoxTree;
  /** Per triangle: how squarely the viewer sees it, the cosine between its normal and the sight line. */
  private readonly facing: Float64Array;
  /** How far in front the nearest face stands, found by the last {@link lookup}: at least `low`, at most `high`. */
  low = -Infinity;
  high = -Infinity;
  /** The faces the last lookups found in front of their point; the caller empties it. */
  readonly hits: number[] = [];

  /**
   * `triangles` holds `x, y, depth` for each of the three corners, nine
   * numbers per triangle; `faces` the face each belongs to; `bands` the mesh
   * error of each face.
   */
  constructor(
    private readonly triangles: Float64Array,
    private readonly faces: Int32Array,
    private readonly bands: ArrayLike<number>,
  ) {
    const count = faces.length;
    const boxes = new Float64Array(count * 4);
    this.facing = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const t = 9 * i;
      boxes[4 * i] = Math.min(triangles[t], triangles[t + 3], triangles[t + 6]);
      boxes[4 * i + 1] = Math.min(triangles[t + 1], triangles[t + 4], triangles[t + 7]);
      boxes[4 * i + 2] = Math.max(triangles[t], triangles[t + 3], triangles[t + 6]);
      boxes[4 * i + 3] = Math.max(triangles[t + 1], triangles[t + 4], triangles[t + 7]);
      const ux = triangles[t + 3] - triangles[t];
      const uy = triangles[t + 4] - triangles[t + 1];
      const uz = triangles[t + 5] - triangles[t + 2];
      const vx = triangles[t + 6] - triangles[t];
      const vy = triangles[t + 7] - triangles[t + 1];
      const vz = triangles[t + 8] - triangles[t + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      this.facing[i] = length > 0 ? Math.abs(nz) / length : 0;
    }
    this.grid = new BoxTree(boxes, count);
  }

  /**
   * How far in front of the point (`x`, `y`, `depth`) the nearest face
   * stands, into {@link low} and {@link high}; both are −∞ when no face is
   * over the point. Faces found in front are added to {@link hits}.
   */
  lookup(x: number, y: number, depth: number): void {
    const { triangles, faces, bands, facing, hits } = this;
    let low = -Infinity;
    let high = -Infinity;
    this.grid.atPoint(x, y, (i) => {
      const cos = facing[i];
      if (cos < 1e-9) {
        return; // seen edge-on: it covers nothing
      }
      const t = 9 * i;
      const ax = triangles[t];
      const ay = triangles[t + 1];
      const bx = triangles[t + 3];
      const by = triangles[t + 4];
      const cx = triangles[t + 6];
      const cy = triangles[t + 7];
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      // Barycentric weights; a point on a shared side belongs to both triangles.
      const wb = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / area;
      const wc = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / area;
      const wa = 1 - wb - wc;
      const slack = -1e-9;
      if (!(wa >= slack && wb >= slack && wc >= slack)) {
        return;
      }
      const front = (wa * triangles[t + 2] + wb * triangles[t + 5] + wc * triangles[t + 8] - depth) * cos;
      const face = faces[i];
      const band = bands[face];
      if (front + band <= 0) {
        return; // behind the point
      }
      if (front - band > low) {
        low = front - band;
      }
      if (front + band > high) {
        high = front + band;
      }
      if (hits.indexOf(face) < 0) {
        hits.push(face);
      }
    });
    this.low = low;
    this.high = high;
  }
}
