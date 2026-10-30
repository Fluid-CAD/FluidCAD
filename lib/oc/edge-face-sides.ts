/**
 * The faces either side of a solid's edge line, as the viewer needs them to
 * draw the line on its own faces.
 *
 * A fat edge line is a screen-space band a few pixels wide around the
 * polyline. Drawn at the polyline's depth, the half of the band that covers a
 * face falling toward the viewer sinks behind it (a rib meeting a floor), and
 * the faces had to be pushed back by a slope-scaled polygon offset to keep
 * the band in front — which, zoomed out, pushed a thin wall behind the edges
 * of whatever stands under it. Instead every segment carries, for the face
 * on each side of it, the direction from the segment into that face: the
 * viewer puts each half of the band on the plane of the face it covers, and
 * the faces keep only a constant offset.
 *
 * The direction comes from the face triangle on the segment — the very
 * triangle the face draws there — so the band and the face share one plane
 * even on curved faces, whatever the face's orientation: nothing here reads
 * a normal, and a reversed face's triangles lie where its forward twin's do.
 * Its length is how far the face runs in that plane from the segment: past
 * it the plane is no longer the face (the 1 mm wall of a hole through a rib,
 * seen edge-on, would otherwise throw the band through the skin in front of
 * it).
 *
 * With two faces, their order says whether the edge is convex: the viewer
 * reads each face's outward normal from that, and so knows when it looks at
 * the edge through the solid's own material (a rib meeting a skin, seen
 * from outside the skin) — then the band's side no face covers stays behind
 * that material.
 */

/** Floats per segment in `faceSides`: two in-face vectors, x y z each. */
export const FACE_SIDE_STRIDE = 6;

/**
 * A side vector rounded for the scene payload, to a ten-thousandth of its
 * length: the viewer needs the plane through the segment and how far the
 * face reaches, and a 1e-4 tilt is far below the depth the band resolves —
 * while `0.7071` costs a third of `0.7071067811865476`.
 */
export function roundSide(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (length === 0 || !Number.isFinite(length)) {
    return [0, 0, 0];
  }
  const scale = Math.pow(10, 4 - Math.floor(Math.log10(length)));
  return [Math.round(x * scale) / scale, Math.round(y * scale) / scale, Math.round(z * scale) / scale];
}

/** Triangles a flat face's reach is followed across — see {@link FaceFacets.reach}. */
const MAX_REACH_STEPS = 64;

/**
 * One face's triangulation as `Mesh.extractFaceTriangulationRaw` read it —
 * node positions in triangulation order (so a polygon-on-triangulation's
 * node `i` is vertex `i - 1`) and its triangles — with the lookup an edge's
 * sides need: the node opposite each mesh edge. Built on first use, then
 * shared by every edge of the face.
 */
export class FaceFacets {
  /** Mesh edge key → the node opposite it in the first triangle that has it. */
  private opposite: Map<number, number> | null = null;
  /** The same for a second triangle: an edge running inside the face has one on each side. */
  private opposite2: Map<number, number> | null = null;
  /** Every triangle's sides as it winds them, from node `a` to `b` keyed `a * nodeCount + b`. */
  private wound: Set<number> | null = null;

  constructor(readonly vertices: ArrayLike<number>, readonly indices: ArrayLike<number>) {}

  get nodeCount(): number {
    return this.vertices.length / 3;
  }

  /** The nodes opposite mesh edge (a, b), 0-based — one on a face boundary, two inside the face, none when no triangle has it. */
  oppositeNodes(a: number, b: number): number[] {
    if (!this.opposite) {
      this.build();
    }
    const key = this.key(a, b);
    const first = this.opposite!.get(key);
    if (first === undefined) {
      return [];
    }
    const second = this.opposite2!.get(key);
    return second === undefined ? [first] : [first, second];
  }

  /**
   * How far the face runs flat from mesh edge (a, b) into its triangle
   * (a, b, c), square to the edge from its midpoint: across that triangle
   * and on through each neighbour lying in the same plane, `MAX_REACH_STEPS`
   * triangles at most. Never less than the triangle's own `height`. A
   * curved face's triangle is all its plane is good for; a flat face goes
   * on, and its triangulation often lines a boundary with slivers a hair
   * high that would otherwise cut its reach to nothing.
   */
  reach(a: number, b: number, c: number, height: number): number {
    const v = this.vertices;
    const ax = v[a * 3], ay = v[a * 3 + 1], az = v[a * 3 + 2];
    const tx = v[b * 3] - ax, ty = v[b * 3 + 1] - ay, tz = v[b * 3 + 2] - az;
    const tLength = Math.hypot(tx, ty, tz);
    const ux = v[c * 3] - ax, uy = v[c * 3 + 1] - ay, uz = v[c * 3 + 2] - az;
    // The plane's frame: e1 along the edge, n its normal, e2 = n × e1 into
    // the triangle. A node's (x, y) is where it sits in the plane.
    let nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
    const nLength = Math.hypot(nx, ny, nz);
    if (tLength === 0 || nLength === 0) {
      return height;
    }
    nx /= nLength; ny /= nLength; nz /= nLength;
    const e1x = tx / tLength, e1y = ty / tLength, e1z = tz / tLength;
    const e2x = ny * e1z - nz * e1y, e2y = nz * e1x - nx * e1z, e2z = nx * e1y - ny * e1x;
    const at = (node: number): [number, number, number] => {
      const px = v[node * 3] - ax, py = v[node * 3 + 1] - ay, pz = v[node * 3 + 2] - az;
      return [px * e1x + py * e1y + pz * e1z, px * e2x + py * e2y + pz * e2z, px * nx + py * ny + pz * nz];
    };
    // Where the line x = x0 crosses mesh edge (p, q), or null.
    const x0 = tLength / 2;
    const crossing = (p: number, q: number): number | null => {
      const [px, py] = at(p);
      const [qx, qy] = at(q);
      if ((px - x0) * (qx - x0) > 0 || px === qx) {
        return null;
      }
      return py + (qy - py) * (x0 - px) / (qx - px);
    };

    let reach = height;
    let entry: [number, number] = [a, b];
    let third = c;
    for (let step = 0; step < MAX_REACH_STEPS; step++) {
      // Out through whichever other side the line leaves the triangle by.
      const [p, q] = entry;
      const viaP = crossing(p, third);
      const viaQ = crossing(q, third);
      const exitY = Math.max(viaP ?? -Infinity, viaQ ?? -Infinity);
      if (!Number.isFinite(exitY) || exitY <= 0) {
        break;
      }
      reach = Math.max(reach, exitY);
      const exit: [number, number] = (viaP ?? -Infinity) >= (viaQ ?? -Infinity) ? [p, third] : [q, third];
      const stay = exit[0] === p ? q : p;
      const next = this.oppositeNodes(exit[0], exit[1]).find(node => node !== stay);
      // A boundary, or a neighbour out of the plane: the flat run ends.
      if (next === undefined || Math.abs(at(next)[2]) > 1e-6 * Math.max(tLength, exitY)) {
        break;
      }
      entry = exit;
      third = next;
    }
    return reach;
  }

  /**
   * The outward normal of triangle (a, b, c), as long as twice its area:
   * the face pieces wind outward (`extractFaceTriangulationRaw` re-winds a
   * reversed face's).
   */
  outwardNormal(a: number, b: number, c: number): [number, number, number] {
    if (!this.wound) {
      this.build();
    }
    const v = this.vertices;
    const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
    const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
    const sign = this.wound!.has(a * this.nodeCount + b) ? 1 : -1;
    return [sign * (uy * wz - uz * wy), sign * (uz * wx - ux * wz), sign * (ux * wy - uy * wx)];
  }

  private build(): void {
    this.opposite = new Map();
    this.opposite2 = new Map();
    this.wound = new Set();
    const idx = this.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      this.record(idx[t], idx[t + 1], idx[t + 2]);
      this.record(idx[t + 1], idx[t + 2], idx[t]);
      this.record(idx[t + 2], idx[t], idx[t + 1]);
    }
  }

  private record(a: number, b: number, c: number): void {
    this.wound!.add(a * this.nodeCount + b);
    const key = this.key(a, b);
    if (!this.opposite!.has(key)) {
      this.opposite!.set(key, c);
    } else if (!this.opposite2!.has(key)) {
      this.opposite2!.set(key, c);
    }
  }

  private key(a: number, b: number): number {
    return a < b ? a * this.nodeCount + b : b * this.nodeCount + a;
  }
}

/**
 * The vector from segment (a, b) into the triangle (a, b, c): in the
 * triangle's plane, square to the segment, toward `c`, as long as the
 * triangle's height over the segment. Null for a triangle with no area.
 */
export function inFaceSide(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] | null {
  const tx = bx - ax, ty = by - ay, tz = bz - az;
  const tt = tx * tx + ty * ty + tz * tz;
  if (tt === 0) {
    return null;
  }
  const ux = cx - ax, uy = cy - ay, uz = cz - az;
  const along = (ux * tx + uy * ty + uz * tz) / tt;
  const sx = ux - along * tx, sy = uy - along * ty, sz = uz - along * tz;
  const length = Math.hypot(sx, sy, sz);
  // Relative to the triangle's size: a sliver whose third node sits on the
  // segment's line gives no direction worth trusting.
  if (length <= 1e-9 * Math.sqrt(Math.max(tt, ux * ux + uy * uy + uz * uz))) {
    return null;
  }
  return [sx, sy, sz];
}

/** One face the edge bounds: its facets and the edge's nodes on its triangulation (0-based, in the edge polyline's order). */
export type EdgeOnFace = { facets: FaceFacets; nodes: number[] };

/**
 * `faceSides` for an edge polyline of `segments` segments: per segment, the
 * direction into the triangle on it in each of `faces` (two at most), as
 * long as the face runs flat from there ({@link FaceFacets.reach}), the two
 * in convexity order ({@link orderByConvexity}) and rounded for the payload
 * — a zero vector where a side has none. Null when no segment found a face
 * (the viewer then draws the line as a plain one).
 */
export function edgeFaceSides(segments: number, faces: EdgeOnFace[]): number[] | null {
  const out = new Array<number>(segments * FACE_SIDE_STRIDE).fill(0);
  let found = false;
  for (let k = 0; k < segments; k++) {
    const slots: { side: [number, number, number]; normal: [number, number, number] }[] = [];
    for (const { facets, nodes } of faces) {
      const a = nodes[k];
      const b = nodes[k + 1];
      const v = facets.vertices;
      for (const c of facets.oppositeNodes(a, b)) {
        if (slots.length === 2) {
          break;
        }
        const side = inFaceSide(
          v[a * 3], v[a * 3 + 1], v[a * 3 + 2],
          v[b * 3], v[b * 3 + 1], v[b * 3 + 2],
          v[c * 3], v[c * 3 + 1], v[c * 3 + 2],
        );
        if (!side) {
          continue;
        }
        const height = Math.hypot(side[0], side[1], side[2]);
        const scale = facets.reach(a, b, c, height) / height;
        slots.push({
          side: [side[0] * scale, side[1] * scale, side[2] * scale],
          normal: facets.outwardNormal(a, b, c),
        });
      }
    }
    if (slots.length === 2) {
      orderByConvexity(slots, faces[0].facets.vertices, faces[0].nodes[k], faces[0].nodes[k + 1]);
    }
    slots.forEach(({ side }, slot) => {
      const base = k * FACE_SIDE_STRIDE + slot * 3;
      const [x, y, z] = roundSide(side[0], side[1], side[2]);
      out[base] = x;
      out[base + 1] = y;
      out[base + 2] = z;
      found = true;
    });
  }
  return found ? out : null;
}

/**
 * Put the two faces of segment (a, b) in the order that tells the viewer
 * the edge's convexity: `(A × B) · (b − a)` positive for a convex edge
 * (face A's outward normal turns away from face B), negative for a concave
 * one. Faces in one plane (a tangent edge, an edge inside its face) carry
 * no order worth reading.
 */
function orderByConvexity(
  slots: { side: [number, number, number]; normal: [number, number, number] }[],
  vertices: ArrayLike<number>, a: number, b: number,
): void {
  const [A, B] = slots;
  const convex = A.normal[0] * B.side[0] + A.normal[1] * B.side[1] + A.normal[2] * B.side[2] < 0;
  const tx = vertices[b * 3] - vertices[a * 3];
  const ty = vertices[b * 3 + 1] - vertices[a * 3 + 1];
  const tz = vertices[b * 3 + 2] - vertices[a * 3 + 2];
  const [ax, ay, az] = A.side;
  const [bx, by, bz] = B.side;
  const triple = (ay * bz - az * by) * tx + (az * bx - ax * bz) * ty + (ax * by - ay * bx) * tz;
  if ((triple > 0) !== convex) {
    slots.reverse();
  }
}

/**
 * `nodes` (a polygon-on-triangulation of another face) put in the order of
 * `reference` (the polyline's own face): the two read the same edge at the
 * same parameters, but each face may store it in its own direction. The
 * ends and the second node decide (a closed edge's ends coincide). Null when
 * the two are not the same discretization, so that face's sides are left
 * out.
 */
export function alignNodes(
  reference: number[], referenceVertices: ArrayLike<number>,
  nodes: number[], vertices: ArrayLike<number>,
): number[] | null {
  if (nodes.length !== reference.length || nodes.length < 2) {
    return null;
  }
  const between = (av: ArrayLike<number>, a: number, bv: ArrayLike<number>, b: number) => Math.hypot(
    av[a * 3] - bv[b * 3], av[a * 3 + 1] - bv[b * 3 + 1], av[a * 3 + 2] - bv[b * 3 + 2],
  );
  const last = nodes.length - 1;
  // The faces share the edge's points, so a match is all but exact and a
  // mismatch is a segment off: a ten-thousandth of one tells them apart.
  const tolerance = 1e-4 * between(referenceVertices, reference[0], referenceVertices, reference[1]);
  const matches = (map: (i: number) => number) => [0, 1, last].every(
    i => between(referenceVertices, reference[i], vertices, nodes[map(i)]) <= tolerance,
  );
  if (matches(i => i)) {
    return nodes;
  }
  if (matches(i => last - i)) {
    return [...nodes].reverse();
  }
  return null;
}
