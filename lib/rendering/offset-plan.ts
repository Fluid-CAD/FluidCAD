// The sketcher's constrained Offset: the picked sketch edges are chained and
// offset by OCCT (BRepOffsetAPI_MakeOffset, Intersection join — sharp corners
// are the two offset edges prolonged to their crossing, never a rounding
// arc), and each result edge comes back as the line, arc or circle statement
// the tool will write, mapped to the picked edge it offsets. The UI turns the
// plan into primitives + one `offsetFrom` statement + a coincident per sharp
// corner; the meshed wires double as the dialog's ghost. Read-only over the
// scene, like the feature ghost: everything built here is freed before
// returning.

import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Wire } from "../common/wire.js";
import { Plane } from "../math/plane.js";
import { Point, Point2D } from "../math/point.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { EdgeQuery } from "../oc/edge-query.js";
import type { MeshSettings } from "../oc/mesh.js";
import { WireOps } from "../oc/wire-ops.js";
import { withUnit } from "../units/registry.js";
import { resolveSketchOpTargets } from "./feature-ghost.js";
import { MeshBuilder } from "./mesh-builder.js";
import type { Scene, SceneObjectMesh } from "./scene.js";

export type SketchOffsetPlanRequest = {
  /** The picked sketch edges (1 shapeId = 1 edge), in pick order. */
  entities: { shapeId: string }[];
  /** Signed offset distance in the sketch's unit — the `offset()` op's own
   * side convention (negative = the other side of an open chain, inward for
   * a closed one). Nonzero. */
  distance: number;
  /** Cap each open chain back onto its sources with two straight edges. */
  close: boolean;
};

export type OffsetPlanVec = [number, number];

/** One offset primitive, sketch-local, oriented along the chain walk. */
export type OffsetPlanEdge =
  | { kind: 'line'; source: number; start: OffsetPlanVec; end: OffsetPlanVec; joinNext: OffsetPlanJoin | null }
  | {
    kind: 'arc'; source: number; start: OffsetPlanVec; end: OffsetPlanVec; center: OffsetPlanVec;
    radius: number; cw: boolean; joinNext: OffsetPlanJoin | null;
  }
  | { kind: 'circle'; source: number; center: OffsetPlanVec; radius: number; joinNext: null };

/**
 * How an offset edge meets the next one along the chain: at a `corner` the
 * two rails cross (a coincident joins them); at a `tangent` junction they
 * meet on their own because their sources do.
 */
export type OffsetPlanJoin = 'corner' | 'tangent';

export type OffsetPlanChain = {
  /** The source chain closes on itself (its last edge joins its first). */
  closed: boolean;
  edges: OffsetPlanEdge[];
  /** `close` caps of an open chain: source end → offset end, offset start → source start. */
  caps?: { start: OffsetPlanVec; end: OffsetPlanVec }[];
};

export type SketchOffsetPlanResult =
  | { ok: true; chains: OffsetPlanChain[]; meshes: SceneObjectMesh[][] }
  | { ok: false; reason: string };

/** Two source directions within this angle (radians) meet tangentially. */
const TANGENT_TOL = 1e-6;

export function planSketchOffset(
  scene: Scene,
  request: SketchOffsetPlanRequest,
  meshConfig: MeshSettings,
): SketchOffsetPlanResult {
  return withUnit(scene.unit, () => planInUnit(scene, request, meshConfig));
}

function planInUnit(scene: Scene, request: SketchOffsetPlanRequest, meshConfig: MeshSettings): SketchOffsetPlanResult {
  if (!Number.isFinite(request.distance) || request.distance === 0) {
    return { ok: false, reason: 'Enter a nonzero distance.' };
  }
  if (request.entities.length === 0) {
    return { ok: false, reason: 'Pick the edges to offset.' };
  }
  const resolved = resolveSketchOpTargets(scene, request.entities);
  if ('reason' in resolved) {
    return { ok: false, reason: resolved.reason };
  }
  const { edges, plane } = resolved;

  const scratch: Shape[] = [];
  const meshed: Shape[] = [];
  try {
    const tolerance = WireOps.connectTolerance(edges);
    // The chain builder re-makes edges to share vertices, so a spine edge is
    // matched back to its pick by geometry (curve kind + midpoint), never by
    // shape identity.
    const sources: PickedSource[] = edges.map((edge, index) => {
      const geometry = EdgeQuery.getEdgeGeometryRaw(edge.getShape());
      if (geometry.kind !== 'line' && geometry.kind !== 'circle') {
        throw new PlanRefusal(`Edge ${index + 1} is not a line, arc or circle — the constrained offset holds only those; use offset() in code for other curves.`);
      }
      return { index, kind: geometry.kind, midPoint: EdgeOps.getEdgeMidPoint(edge) };
    });
    const wires: Wire[] = [];
    for (const group of WireOps.groupConnectedEdges(edges, tolerance)) {
      wires.push(...WireOps.makeChainWires(group, tolerance));
    }
    scratch.push(...wires);

    const chains: OffsetPlanChain[] = [];
    for (const wire of wires) {
      chains.push(planChain(wire, sources, plane, request, tolerance, scratch, meshed));
    }
    const builder = new MeshBuilder(meshConfig);
    const meshes: SceneObjectMesh[][] = [];
    for (const shape of meshed) {
      const built = builder.build(shape);
      if (built) {
        meshes.push(built);
      }
    }
    return { ok: true, chains, meshes };
  } catch (err) {
    if (err instanceof PlanRefusal) {
      return { ok: false, reason: err.message };
    }
    throw err;
  } finally {
    for (const shape of [...meshed, ...scratch]) {
      shape.dispose();
    }
  }
}

class PlanRefusal extends Error {}

/** A picked edge as the chain builder's edges are matched back to it. */
type PickedSource = { index: number; kind: 'line' | 'circle'; midPoint: Point };

/** A source edge's analytic description in sketch coordinates, walked
 * start → end along the chain. */
type SourceCurve =
  | { kind: 'line'; start: OffsetPlanVec; end: OffsetPlanVec }
  | { kind: 'arc'; start: OffsetPlanVec; end: OffsetPlanVec; center: OffsetPlanVec; cw: boolean }
  | { kind: 'circle'; center: OffsetPlanVec };

function planChain(
  wire: Wire,
  picked: PickedSource[],
  plane: Plane,
  request: SketchOffsetPlanRequest,
  tolerance: number,
  scratch: Shape[],
  meshed: Shape[],
): OffsetPlanChain {
  const closed = wire.isClosed();
  // The same side conventions as Offset.build / the ghost (offsetWireOnPlane):
  // an open chain's negative distance is the other side (offset the reversed
  // wire by the magnitude); a closed chain's sign is outward/inward whatever
  // its own direction, so it is normalized counter-clockwise first.
  let spine = wire;
  let distance = request.distance;
  if (!closed) {
    if (distance < 0) {
      spine = WireOps.reverseWire(wire);
      scratch.push(spine);
      distance = -distance;
    }
  } else if (WireOps.isCW(wire, plane.normal)) {
    spine = WireOps.reverseWire(wire);
    scratch.push(spine);
  }

  let offset: { wire: Wire; generated: (spineEdge: Edge) => Edge[] };
  try {
    offset = closed
      ? offsetClosed(spine, distance, plane)
      : WireOps.offsetWireGenerated(spine, distance, true, plane, 'intersection');
  } catch (err) {
    throw new PlanRefusal(`OCCT cannot offset this chain by ${fmt(request.distance)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  meshed.push(offset.wire);

  // Walk the spine in chain order; each spine edge is one of the picked
  // edges (same curve, maybe reversed) and generates exactly one offset edge.
  const spineEdges = spine.getEdges();
  let sources: SourceCurve[] = [];
  let edges: OffsetPlanEdge[] = [];
  for (const spineEdge of spineEdges) {
    const index = pickedIndexOf(spineEdge, picked, tolerance);
    const curve = describeSource(spineEdge, plane);
    const generated = offset.generated(spineEdge);
    if (generated.length === 0) {
      throw new PlanRefusal(`Edge ${index + 1} vanishes at this distance — the offset swallows it; use a smaller distance or leave it out.`);
    }
    if (generated.length > 1) {
      throw new PlanRefusal(`Edge ${index + 1} offsets to ${generated.length} pieces at this distance — the constrained offset holds one primitive per edge.`);
    }
    sources.push(curve);
    edges.push(describeOffset(generated[0], index, curve, plane));
  }
  // A spine walked backwards (the other side of an open chain, a clockwise
  // closed one) is handed back in the picked chain's own direction.
  if (spine !== wire) {
    sources = sources.reverse().map(reverseSource);
    edges = edges.reverse().map(reverseOffset);
  }

  // Junctions: consecutive edges of the chain (and last → first when
  // closed). Tangent sources meet on their own; a kink is a corner the two
  // rails are prolonged to — either way the generated edges must actually
  // meet there, or OCCT did something the plan cannot hold.
  const count = edges.length;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    if (next === i || (!closed && next === 0)) {
      continue;
    }
    const here = edges[i];
    const after = edges[next];
    if (here.kind === 'circle' || after.kind === 'circle') {
      continue;
    }
    const gap = dist(here.end, after.start);
    if (gap > tolerance * 10) {
      throw new PlanRefusal(`The offsets of edges ${here.source + 1} and ${after.source + 1} do not meet at this distance (gap ${fmt(gap)}).`);
    }
    here.joinNext = sourcesTangentAt(sources[i], sources[next]) ? 'tangent' : 'corner';
  }

  const chain: OffsetPlanChain = { closed, edges };
  const first = sources[0];
  const last = sources[count - 1];
  const firstEdge = edges[0];
  const lastEdge = edges[count - 1];
  if (request.close && !closed && count > 0
    && first.kind !== 'circle' && last.kind !== 'circle'
    && firstEdge.kind !== 'circle' && lastEdge.kind !== 'circle') {
    chain.caps = [
      { start: last.end, end: lastEdge.end },
      { start: firstEdge.start, end: first.start },
    ];
    for (const cap of chain.caps) {
      meshed.push(EdgeOps.makeLineEdge(plane.localToWorld(toPoint2D(cap.start)), plane.localToWorld(toPoint2D(cap.end))));
    }
  }
  return chain;
}

function reverseSource(curve: SourceCurve): SourceCurve {
  if (curve.kind === 'circle') {
    return curve;
  }
  if (curve.kind === 'line') {
    return { kind: 'line', start: curve.end, end: curve.start };
  }
  return { kind: 'arc', start: curve.end, end: curve.start, center: curve.center, cw: !curve.cw };
}

function reverseOffset(edge: OffsetPlanEdge): OffsetPlanEdge {
  if (edge.kind === 'circle') {
    return edge;
  }
  if (edge.kind === 'line') {
    return { ...edge, start: edge.end, end: edge.start };
  }
  return { ...edge, start: edge.end, end: edge.start, cw: !edge.cw };
}

/** Closed chains: the plane-less offset first (what the path circles rely
 * on), the plane-backed one as the fallback — the ghost's own order. */
function offsetClosed(spine: Wire, distance: number, plane: Plane): { wire: Wire; generated: (spineEdge: Edge) => Edge[] } {
  try {
    return WireOps.offsetWireGenerated(spine, distance, false, undefined, 'intersection');
  } catch {
    return WireOps.offsetWireGenerated(spine, distance, false, plane, 'intersection');
  }
}

function pickedIndexOf(spineEdge: Edge, picked: PickedSource[], tolerance: number): number {
  const geometry = EdgeQuery.getEdgeGeometryRaw(spineEdge.getShape());
  const midPoint = EdgeOps.getEdgeMidPoint(spineEdge);
  let best: PickedSource | null = null;
  let bestDistance = Infinity;
  for (const source of picked) {
    if (source.kind !== geometry.kind) {
      continue;
    }
    const d = source.midPoint.distanceTo(midPoint);
    if (d < bestDistance) {
      best = source;
      bestDistance = d;
    }
  }
  if (!best || bestDistance > tolerance * 10) {
    throw new PlanRefusal('The chain holds an edge that was not picked.');
  }
  return best.index;
}

function toPoint2D(v: OffsetPlanVec): Point2D {
  return new Point2D(v[0], v[1]);
}

function local(plane: Plane, p: Point): OffsetPlanVec {
  const q = plane.worldToLocal(p);
  return [q.x, q.y];
}

function dist(a: OffsetPlanVec, b: OffsetPlanVec): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Whether the arc start → end around center sweeps clockwise, read off a
 * point of the edge between them (an arc past 180° needs it). */
function sweepCw(start: OffsetPlanVec, midPoint: OffsetPlanVec, center: OffsetPlanVec): boolean {
  const ax = start[0] - center[0];
  const ay = start[1] - center[1];
  const mx = midPoint[0] - center[0];
  const my = midPoint[1] - center[1];
  return ax * my - ay * mx < 0;
}

/**
 * The spine edge as walked: its first vertex is the chain-order start (the
 * wire explorer hands edges with their orientation applied through the
 * wrapper's first/last vertex reads).
 */
function describeSource(edge: Edge, plane: Plane): SourceCurve {
  const geometry = EdgeQuery.getEdgeGeometryRaw(edge.getShape());
  const first = edge.getFirstVertex();
  const last = edge.getLastVertex();
  const start = local(plane, first.toPoint());
  const end = local(plane, last.toPoint());
  first.dispose();
  last.dispose();
  if (geometry.kind === 'line') {
    return { kind: 'line', start, end };
  }
  if (geometry.kind !== 'circle') {
    throw new PlanRefusal('A picked edge is not a line, arc or circle.');
  }
  const center = local(plane, geometry.center);
  if (geometry.closed || dist(start, end) <= 1e-9) {
    return { kind: 'circle', center };
  }
  const midPoint = local(plane, EdgeOps.getEdgeMidPoint(edge));
  return { kind: 'arc', start, end, center, cw: sweepCw(start, midPoint, center) };
}

/**
 * The generated edge as the primitive the tool writes, oriented like its
 * source along the walk: a line's start is the end that projects earlier on
 * the source; an arc's start is the end nearer the source's start by angle.
 */
function describeOffset(edge: Edge, source: number, curve: SourceCurve, plane: Plane): OffsetPlanEdge {
  const geometry = EdgeQuery.getEdgeGeometryRaw(edge.getShape());
  const first = edge.getFirstVertex();
  const last = edge.getLastVertex();
  let a = local(plane, first.toPoint());
  let b = local(plane, last.toPoint());
  first.dispose();
  last.dispose();
  if (geometry.kind === 'line') {
    if (curve.kind !== 'line') {
      throw new PlanRefusal(`Edge ${source + 1} offsets to a line although it is not one.`);
    }
    const ux = curve.end[0] - curve.start[0];
    const uy = curve.end[1] - curve.start[1];
    const ta = (a[0] - curve.start[0]) * ux + (a[1] - curve.start[1]) * uy;
    const tb = (b[0] - curve.start[0]) * ux + (b[1] - curve.start[1]) * uy;
    if (tb < ta) {
      [a, b] = [b, a];
    }
    return { kind: 'line', source, start: a, end: b, joinNext: null };
  }
  if (geometry.kind !== 'circle') {
    throw new PlanRefusal(`Edge ${source + 1} offsets to a curve the sketch cannot hold as a line or arc.`);
  }
  const center = local(plane, geometry.center);
  if (curve.kind === 'circle') {
    return { kind: 'circle', source, center, radius: geometry.radius, joinNext: null };
  }
  if (curve.kind !== 'arc') {
    throw new PlanRefusal(`Edge ${source + 1} offsets to an arc although it is not one.`);
  }
  const angleOf = (p: OffsetPlanVec, c: OffsetPlanVec): number => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const gap = (x: number, y: number): number => {
    const d = Math.abs(x - y) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
  };
  const sourceStartAngle = angleOf(curve.start, curve.center);
  if (gap(angleOf(b, center), sourceStartAngle) < gap(angleOf(a, center), sourceStartAngle)) {
    [a, b] = [b, a];
  }
  return { kind: 'arc', source, start: a, end: b, center, radius: geometry.radius, cw: curve.cw, joinNext: null };
}

/** The unit tangent of a source curve at its start or end, along the walk. */
function tangentAt(curve: SourceCurve, at: 'start' | 'end'): OffsetPlanVec | null {
  if (curve.kind === 'circle') {
    return null;
  }
  if (curve.kind === 'line') {
    const ux = curve.end[0] - curve.start[0];
    const uy = curve.end[1] - curve.start[1];
    const len = Math.hypot(ux, uy) || 1;
    return [ux / len, uy / len];
  }
  const p = at === 'start' ? curve.start : curve.end;
  const rx = p[0] - curve.center[0];
  const ry = p[1] - curve.center[1];
  const len = Math.hypot(rx, ry) || 1;
  // CCW travel: tangent = perp(radial) = (−ry, rx); CW: the opposite.
  return curve.cw ? [ry / len, -rx / len] : [-ry / len, rx / len];
}

function sourcesTangentAt(here: SourceCurve, next: SourceCurve): boolean {
  const t1 = tangentAt(here, 'end');
  const t2 = tangentAt(next, 'start');
  if (!t1 || !t2) {
    return false;
  }
  const cross = t1[0] * t2[1] - t1[1] * t2[0];
  const dot = t1[0] * t2[0] + t1[1] * t2[1];
  return dot > 0 && Math.abs(cross) < TANGENT_TOL;
}
