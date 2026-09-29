// Constraint-native 2D offset.
//
// The Offset tool no longer writes an `offset(d, …)` derived op inside a
// solved sketch: it emits the offset curves as real `line` / `arc` /
// `circle` statements plus ONE `offsetFrom([o1, o2, …], [s1, s2, …], d)`
// constraint pairing each with the picked edge it follows, and a
// `coincident` per sharp corner of the chain (where two offsets are
// prolonged to their crossing). Tangent junctions get no coincident — the
// offsets meet there on their own because their sources do — and the ends of
// an open chain sit square across from their sources' ends. "Close ends"
// adds the two cap lines, each pinned by coincidents to a source end and
// the offset end across from it.
//
// The geometry here is only the GUESS: it comes from the server's OCCT plan
// (`api/sketch-offset-plan`, the Intersection join) so the corners land where
// the kernel's own offset would put them; the constraints own the truth.

import type { SolvedConstraintParam, SolvedGeometryParam, SolvedEmissionTargetParam } from '../../api';
import type { SketchOffsetPlanChain, SketchOffsetPlanEdge } from '../../api';
import type { SolvedSketchModel } from '../../sketch-solver-client/model';
import type { SolvedPick } from '../sketch-hover-select-handler';
import { constraintTargetFor } from '../solved-constraint-toolbar/constraint-targets';
import { arcText, circleText, coincident, lineText, newTarget, type SolvedEmissionRequest } from './solved-emission';

export type OffsetEmissionPlan = {
  ok: true;
  request: SolvedEmissionRequest;
  /** Offset primitives emitted (caps excluded). */
  edges: number;
  /** Sharp corners joined by a coincident. */
  corners: number;
};

export type OffsetEmissionError = { ok: false; reason: string };

const fail = (reason: string): OffsetEmissionError => ({ ok: false, reason });

type V2 = [number, number];
const p2 = (p: V2): V2 => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];

/**
 * Whether the selection must be written as an `offset()` statement instead
 * of constrained geometry: the offset of a bezier or an ellipse is neither
 * a bezier nor an ellipse (nor any sketch primitive), so no `offsetFrom`
 * pair can hold it exactly. The derived op offsets the whole selection
 * with the kernel's exact curves — one statement, one distance, no solver
 * identity — the way the tool wrote every offset before the constrained
 * path existed.
 */
export function offsetNeedsStatement(picks: SolvedPick[]): boolean {
  // An edge pick carries a shapeId and no role. A bezier's edge resolves to
  // one of its control-point anchors (its only solver entities), so the
  // pick reads `kind: 'point'` with `anchor.owner === 'bezier'`; a control
  // point picked as a vertex has `role: null` and is not an edge pick.
  return picks.some(pick =>
    pick.role === undefined && pick.datum === undefined && pick.shapeId !== undefined
    && (pick.kind === 'ellipse' || pick.anchor?.owner === 'bezier'));
}

/**
 * The edge picks the plan was requested for, in request order — the plan's
 * `source` indices address this list. Vertex, datum and anchor picks never
 * reach the plan; a pick the constrained offset cannot follow is refused
 * here with the reason the dialog shows.
 */
export function offsetSourcePicks(picks: SolvedPick[]): { ok: true; picks: SolvedPick[] } | OffsetEmissionError {
  const sources: SolvedPick[] = [];
  const seen = new Set<string>();
  for (const pick of picks) {
    if (pick.role !== undefined || pick.datum !== undefined || pick.shapeId === undefined) {
      continue;
    }
    if (seen.has(pick.shapeId)) {
      continue;
    }
    if (pick.anchor !== undefined) {
      return fail(`a ${pick.anchor.owner} has no edge to offset — pick lines, arcs or circles`);
    }
    if (pick.kind !== 'line' && pick.kind !== 'arc' && pick.kind !== 'circle') {
      return fail(`a ${pick.kind} cannot be offset as constrained geometry — a selection holding one is written as an offset() statement`);
    }
    if (pick.sourceLocation?.line === undefined) {
      return fail('a picked edge has no statement to follow');
    }
    seen.add(pick.shapeId);
    sources.push(pick);
  }
  if (sources.length === 0) {
    return fail('pick the edges to offset');
  }
  return { ok: true, picks: sources };
}

/**
 * Build the constraint-native offset emission from the server's plan.
 * `distanceExpr` rides the offsetFrom dimension verbatim (positive — the
 * side comes from the guesses); `sources` is the list the plan's indices
 * address, as {@link offsetSourcePicks} returned it.
 */
export function buildOffsetEmission(opts: {
  sources: SolvedPick[];
  chains: SketchOffsetPlanChain[];
  model: SolvedSketchModel;
  distanceExpr: string;
}): OffsetEmissionPlan | OffsetEmissionError {
  const { sources, chains, model } = opts;
  const geometry: SolvedGeometryParam[] = [];
  const constraints: SolvedConstraintParam[] = [];
  const offsetTargets: SolvedEmissionTargetParam[] = [];
  const sourceTargets: SolvedEmissionTargetParam[] = [];
  let corners = 0;
  let edges = 0;

  for (const chain of chains) {
    const indices: number[] = [];
    for (const edge of chain.edges) {
      const pick = sources[edge.source];
      if (!pick) {
        return fail('the offset plan no longer matches the picks — pick the edges again');
      }
      indices.push(geometry.length);
      geometry.push(geometryOf(edge));
      offsetTargets.push(newTarget(geometry.length - 1));
      sourceTargets.push(constraintTargetFor(pick));
      edges++;
    }
    // Sharp corners: a coincident joins the two offsets prolonged to their
    // crossing. Tangent junctions and open ends need nothing.
    const count = chain.edges.length;
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      if (next === i || (!chain.closed && next === 0)) {
        continue;
      }
      if (chain.edges[i].joinNext === 'corner') {
        constraints.push(coincident(newTarget(indices[i], 'end'), newTarget(indices[next], 'start')));
        corners++;
      }
    }
    // Close-ends caps: source end → offset end, offset start → source start,
    // each cap pinned at both ends.
    if (chain.caps && count > 0) {
      const firstEdge = chain.edges[0];
      const lastEdge = chain.edges[count - 1];
      const firstPick = sources[firstEdge.source];
      const lastPick = sources[lastEdge.source];
      if (firstEdge.kind !== 'circle' && lastEdge.kind !== 'circle' && firstPick && lastPick) {
        const [endCap, startCap] = chain.caps;
        const sourceEndRole = sourceEndAt(model, lastPick, endCap.start);
        const sourceStartRole = sourceEndAt(model, firstPick, startCap.end);
        if (!sourceEndRole || !sourceStartRole) {
          return fail('the chain ends do not sit on the picked edges\' ends — pick the edges again');
        }
        const endCapIndex = geometry.length;
        geometry.push({ kind: 'line', text: lineText(p2(endCap.start), p2(endCap.end)) });
        constraints.push(
          coincident(newTarget(endCapIndex, 'start'), sourceEndRole),
          coincident(newTarget(endCapIndex, 'end'), newTarget(indices[count - 1], 'end')),
        );
        const startCapIndex = geometry.length;
        geometry.push({ kind: 'line', text: lineText(p2(startCap.start), p2(startCap.end)) });
        constraints.push(
          coincident(newTarget(startCapIndex, 'start'), newTarget(indices[0], 'start')),
          coincident(newTarget(startCapIndex, 'end'), sourceStartRole),
        );
      }
    }
  }
  if (edges === 0) {
    return fail('nothing to offset');
  }
  // The offsetFrom statement itself goes FIRST so the emitted coincidents
  // read as the chain's corners after it in the source.
  constraints.unshift({
    kind: 'offsetFrom',
    targets: [...offsetTargets, ...sourceTargets],
    valueExpr: opts.distanceExpr,
  });
  return { ok: true, edges, corners, request: { geometry, constraints } };
}

function geometryOf(edge: SketchOffsetPlanEdge): SolvedGeometryParam {
  if (edge.kind === 'line') {
    return { kind: 'line', text: lineText(p2(edge.start), p2(edge.end)) };
  }
  if (edge.kind === 'arc') {
    return { kind: 'arc', text: arcText(p2(edge.start), p2(edge.end), p2(edge.center), edge.cw) };
  }
  return { kind: 'circle', text: circleText(p2(edge.center), Math.round(edge.radius * 2 * 100) / 100) };
}

/** A chain end lands on this many units of a source statement's endpoint. */
const END_TOL = 1e-3;

/**
 * The picked statement's endpoint (`start` / `end` role) at chain position
 * `at` — the chain may walk a statement backwards, so the role is read off
 * the solved geometry rather than assumed. Null when neither end is there.
 */
function sourceEndAt(model: SolvedSketchModel, pick: SolvedPick, at: V2): SolvedEmissionTargetParam | null {
  const view = model.entities.get(pick.entityId);
  if (!view || !view.start || !view.end) {
    return null;
  }
  const near = (p: [number, number]): boolean => Math.hypot(p[0] - at[0], p[1] - at[1]) <= END_TOL;
  const role = near(view.start) ? 'start' : near(view.end) ? 'end' : null;
  return role ? { ...constraintTargetFor(pick), role } : null;
}
