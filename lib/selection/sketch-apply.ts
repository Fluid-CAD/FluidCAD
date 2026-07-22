import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Sketch } from "../features/2d/sketch.js";
import { ShapeFilter } from "../filters/filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { EdgeProps } from "../oc/edge-props.js";
import { allocateNames, collectImports, renderPartArgs } from "./explain.js";
import { SelectorPart } from "./synthesis.js";
import {
  ApplyFeatureEditSpec,
  ApplyFeatureSynthesis,
  SelectionScene,
  SynthesizeOptions,
  nameHintFor,
} from "./types.js";

/** A sketch edge pick: 1 shapeId = 1 edge (the Stage 0 emission invariant). */
export type SketchPickRef = { shapeId: string };

export type SketchApplyFeatureKind = 'fillet';

type ResolvedSketchPick = {
  ref: SketchPickRef;
  edge: Edge;
  owner: SceneObject;
};

type OwnerGroup = {
  owner: SceneObject;
  picks: ResolvedSketchPick[];
};

/** One owner group's candidate renderings, best first. */
type GroupCandidates = {
  /** Parts for the winning form (one or more args). */
  winner: SelectorPart[];
  /** Verified runner-up forms (each a full replacement for the group). */
  alternatives: SelectorPart[][];
};

/**
 * Selector synthesis for sketch-edge picks — the 2D branch of the selection
 * kernel. Picks resolve `{shapeId}` → edge → owning primitive through the
 * sketch's edge index; owner-bindable groups synthesize construction-relative
 * accessors (`r.edge('top')`, bare variables for single-edge primitives,
 * `edge(i)` indices), everything else pools into an induced edge-filter
 * argument (`edge().arc(4)`) evaluated against the whole sketch. Every
 * candidate is verified by executing the same resolution the emitted code
 * would run. The resulting spec reuses the 3D ApplyFeatureEditSpec shape:
 * producers are statements inside the sketch body, and the transform's
 * shared-scope rule keeps the emitted statement in that same body.
 */
export function synthesizeSketchApplyFeature(
  scene: SelectionScene,
  refs: SketchPickRef[],
  feature: SketchApplyFeatureKind,
  value?: number | string,
  options: SynthesizeOptions = {},
): ApplyFeatureSynthesis {
  if (refs.length === 0) {
    return { ok: false, reason: 'nothing selected' };
  }

  const resolution = resolvePicks(scene, refs);
  if ('reason' in resolution) {
    return { ok: false, reason: resolution.reason };
  }
  const { sketch, picks } = resolution;

  // The emitted statement runs at the end of the sketch body, so its universe
  // is the sketch's final edge set — exactly this index.
  const universe = [...sketch.getEdgesWithOwner().keys()];

  // Bindable owners synthesize accessors; the rest pool into a filter.
  const groups: OwnerGroup[] = [];
  const pool: ResolvedSketchPick[] = [];
  for (const pick of picks) {
    if (checkSketchBindable(scene, pick.owner) === null) {
      const group = groups.find(g => g.owner === pick.owner);
      if (group) {
        group.picks.push(pick);
      } else {
        groups.push({ owner: pick.owner, picks: [pick] });
      }
    } else {
      pool.push(pick);
    }
  }

  const producers: SceneObject[] = [];
  const groupResults: GroupCandidates[] = [];

  for (const group of groups) {
    const candidates = synthesizeOwnerCandidates(group);
    if (candidates === null) {
      // The owner cannot express these picks — fall back to the filter pool.
      pool.push(...group.picks);
      continue;
    }
    producers.push(group.owner);
    groupResults.push(candidates);
  }

  if (pool.length > 0) {
    const filterPart = induceSketchFilterPart(universe, pool.map(p => p.edge));
    if (!filterPart) {
      return {
        ok: false,
        reason: sketchFilterFailureReason(scene, pool),
      };
    }
    groupResults.push({ winner: [filterPart], alternatives: [] });
  }

  // Anchor for insertion scope when nothing is bound: any picked statement
  // inside the sketch body with a source location.
  let anchor: SceneObject | null = null;
  if (producers.length === 0) {
    anchor = picks.map(p => p.owner).find(o => o.getSourceLocation()) ?? null;
    if (!anchor) {
      return { ok: false, reason: 'no source location is available to anchor the edit' };
    }
  }

  const located = producers.map(p => ({ feature: p, bind: true }));
  if (anchor) {
    located.push({ feature: anchor, bind: false });
  }

  const filePaths = new Set(located.map(l => l.feature.getSourceLocation()!.filePath));
  if (filePaths.size > 1) {
    return { ok: false, reason: 'the picked edges come from statements in different files' };
  }

  const names = allocateNames(producers, options.namer);
  const winners = groupResults.flatMap(g => g.winner);
  const renderParts = (parts: SelectorPart[]) =>
    parts.map(part => renderPartArgs(part, names)).join(', ');

  const spec: ApplyFeatureEditSpec = {
    feature,
    value,
    filePath: filePaths.values().next().value!,
    producers: located.map(l => {
      const loc = l.feature.getSourceLocation()!;
      return {
        line: loc.line,
        column: loc.column,
        featureType: l.feature.getType(),
        nameHint: nameHintFor(l.feature.getType()),
        bind: l.bind,
      };
    }),
    parts: winners.map(part => ({
      producer: part.producer ? producers.indexOf(part.producer) : null,
      accessor: part.accessor,
      indices: part.indices,
      filterArgs: part.filterArgs,
    })),
    imports: collectImports(winners),
  };

  // Statement-level alternatives: vary one group at a time, in group order.
  const args = renderParts(winners);
  const alternatives: string[] = [];
  for (let i = 0; i < groupResults.length && alternatives.length < 3; i++) {
    for (const alt of groupResults[i].alternatives) {
      if (alternatives.length >= 3) {
        break;
      }
      const variant = groupResults.map((g, gi) => (gi === i ? alt : g.winner)).flat();
      alternatives.push(renderParts(variant));
    }
  }

  return {
    ok: true,
    spec,
    preview: `${feature}(${value}, ${args})`,
    args,
    alternatives,
  };
}

/** Resolve every `{shapeId}` pick to its edge and owner in ONE sketch. */
function resolvePicks(
  scene: SelectionScene,
  refs: SketchPickRef[],
): { sketch: Sketch; picks: ResolvedSketchPick[] } | { reason: string } {
  const sketches = scene.getAllSceneObjects()
    .filter((o): o is Sketch => o instanceof Sketch);

  const indexBySketch = new Map<Sketch, Map<string, { edge: Edge; owner: SceneObject }>>();
  for (const sketch of sketches) {
    const byId = new Map<string, { edge: Edge; owner: SceneObject }>();
    for (const [edge, owner] of sketch.getEdgesWithOwner()) {
      byId.set(edge.id, { edge, owner });
    }
    indexBySketch.set(sketch, byId);
  }

  let pickedSketch: Sketch | null = null;
  const picks: ResolvedSketchPick[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (seen.has(ref.shapeId)) {
      continue;
    }
    seen.add(ref.shapeId);

    let resolved: { sketch: Sketch; edge: Edge; owner: SceneObject } | null = null;
    for (const [sketch, byId] of indexBySketch) {
      const hit = byId.get(ref.shapeId);
      if (hit) {
        resolved = { sketch, ...hit };
        break;
      }
    }
    if (!resolved) {
      return { reason: 'a pick does not resolve to a sketch edge in the current scene' };
    }
    if (pickedSketch && resolved.sketch !== pickedSketch) {
      return { reason: 'the picked edges live in different sketches — apply the operation per sketch' };
    }
    pickedSketch = resolved.sketch;
    picks.push({ ref, edge: resolved.edge, owner: resolved.owner });
  }

  if (!pickedSketch) {
    return { reason: 'nothing selected' };
  }
  return { sketch: pickedSketch, picks };
}

/** Failure reason when the owner cannot be bound to a variable, null when it can. */
export function checkSketchBindable(scene: SelectionScene, owner: SceneObject): string | null {
  if (owner.getCloneSource()) {
    return `this edge belongs to a repeated ${owner.getType()}() instance`;
  }
  const loc = owner.getSourceLocation();
  if (!loc) {
    return `the producing ${owner.getType()}() has no recorded source location`;
  }
  let count = 0;
  for (const obj of scene.getAllSceneObjects()) {
    const objLoc = obj.getSourceLocation();
    if (obj.getType() === owner.getType() && objLoc
      && objLoc.filePath === loc.filePath && objLoc.line === loc.line && objLoc.column === loc.column) {
      count++;
    }
  }
  if (count > 1) {
    return `the ${owner.getType()}() call site produces multiple statements (loop or helper)`;
  }
  return null;
}

/** The owner's real (non-meta, non-guide) edges in build order. */
function ownerRealEdges(owner: SceneObject): Edge[] {
  return owner.getShapes().filter((s): s is Edge => s instanceof Edge);
}

/**
 * Owner-accessor candidates for one owner's picked edges, best first:
 * bare variable (single-edge primitives), role accessors (`edge('top')`,
 * `edge('side', 2)`, whole-role `edge('side')`), then build-order indices
 * (`edge(1)`). Every form is verified against the accessor's own resolution
 * (the owner's current edges). Returns null when no form works.
 */
function synthesizeOwnerCandidates(group: OwnerGroup): GroupCandidates | null {
  const owner = group.owner;
  const edges = ownerRealEdges(owner);
  const picked = new Set(group.picks.map(p => p.edge));
  const forms: SelectorPart[][] = [];

  // Bare variable: the picks cover everything the feature owns.
  if (picked.size === edges.length && edges.every(e => picked.has(e))) {
    forms.push([part(owner, '', null, null, 0)]);
  }

  const roleForm = synthesizeRoleParts(owner, edges, picked);
  if (roleForm) {
    forms.push(roleForm);
  }

  const indexForm: SelectorPart[] = [];
  for (const edge of edges) {
    if (!picked.has(edge)) {
      continue;
    }
    const index = edges.indexOf(edge);
    if (!resolvesToExactly(evaluateEdgeAccessor(edges, index), [edge])) {
      return forms.length > 0 ? toCandidates(forms) : null;
    }
    indexForm.push(part(owner, 'edge', null, `${index}`, 4));
  }
  forms.push(indexForm);

  return toCandidates(forms);
}

/** Role-accessor parts covering the picked set exactly, or null. */
function synthesizeRoleParts(
  owner: SceneObject,
  edges: Edge[],
  picked: Set<Edge>,
): SelectorPart[] | null {
  // Group the picks by role; every picked edge must carry one.
  const byRole = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (!picked.has(edge)) {
      continue;
    }
    if (edge.role === undefined) {
      return null;
    }
    byRole.set(edge.role, [...(byRole.get(edge.role) ?? []), edge]);
  }

  const parts: SelectorPart[] = [];
  for (const [role, members] of byRole) {
    const roleMembers = edges.filter(e => e.role === role);
    if (members.length === roleMembers.length) {
      // Whole role: one accessor covers it.
      if (!resolvesToExactly(evaluateRoleAccessor(edges, role, undefined), members)) {
        return null;
      }
      parts.push(part(owner, 'edge', null, `'${role}'`, 0));
      continue;
    }
    for (const edge of members) {
      if (edge.roleIndex === undefined
        || !resolvesToExactly(evaluateRoleAccessor(edges, role, edge.roleIndex), [edge])) {
        return null;
      }
      parts.push(part(owner, 'edge', null, `'${role}', ${edge.roleIndex}`, 0));
    }
  }
  return parts;
}

/** Mirrors `GeometrySceneObject.edge(role, roleIndex?)` resolution. */
function evaluateRoleAccessor(edges: Edge[], role: string, roleIndex: number | undefined): Edge[] {
  let matches = edges.filter(e => e.role === role);
  if (roleIndex !== undefined) {
    matches = matches.filter(e => e.roleIndex === roleIndex);
  }
  return matches;
}

/** Mirrors `GeometrySceneObject.edge(index)` resolution. */
function evaluateEdgeAccessor(edges: Edge[], index: number): Edge[] {
  const edge = edges[index];
  return edge ? [edge] : [];
}

function resolvesToExactly(resolved: Edge[], expected: Edge[]): boolean {
  if (resolved.length !== expected.length) {
    return false;
  }
  const set = new Set(resolved);
  return expected.every(e => set.has(e));
}

function part(
  producer: SceneObject | null,
  accessor: string,
  indices: number[] | null,
  filterArgs: string | null,
  tier: 0 | 1 | 2 | 3 | 4,
): SelectorPart {
  return { producer, accessor, indices, filterArgs, tier };
}

function toCandidates(forms: SelectorPart[][]): GroupCandidates {
  return { winner: forms[0], alternatives: forms.slice(1) };
}

/**
 * Induce one bare edge-filter argument list resolving to exactly the picked
 * edges over the sketch universe: curve kind, optionally narrowed by the
 * picked dimension (`edge().arc(4)`), degrading to one argument per pick.
 * Verified by running the composed builders exactly as the op would.
 */
function induceSketchFilterPart(universe: Edge[], picks: Edge[]): SelectorPart | null {
  const single = induceFilterBuilders(universe, picks);
  if (single) {
    return part(null, 'filter', null, single, 3);
  }
  if (picks.length >= 2 && picks.length <= 3) {
    const rendered: string[] = [];
    for (const pick of picks) {
      const one = induceFilterBuilders(universe, [pick]);
      if (!one) {
        return null;
      }
      rendered.push(one);
    }
    return part(null, 'filter', null, rendered.join(', '), 3);
  }
  return null;
}

/** One conjunction (as rendered text) matching exactly `picks`, or null. */
function induceFilterBuilders(universe: Edge[], picks: Edge[]): string | null {
  const kind = classifyEdge(picks[0]);
  if (!kind || picks.some(p => classifyEdge(p) !== kind)) {
    return null;
  }

  const candidates: { args: string; builder: EdgeFilterBuilder }[] = [];
  candidates.push({ args: '', builder: kindBuilder(kind, undefined) });

  const dims = picks.map(edgeDimension);
  const dim = dims[0];
  if (dim !== null && dims.every(d => d !== null && Math.abs(d - dim) < 1e-9)) {
    for (const value of [roundDim(dim), dim]) {
      candidates.push({ args: formatDim(value), builder: kindBuilder(kind, value) });
      if (value === dim) {
        break;
      }
    }
  }

  for (const candidate of candidates) {
    const resolved = new ShapeFilter(universe, candidate.builder).apply() as Edge[];
    if (resolvesToExactly(resolved, picks)) {
      return `edge().${kind}(${candidate.args})`;
    }
  }
  return null;
}

function classifyEdge(edge: Edge): 'line' | 'arc' | 'circle' | null {
  const curveType = EdgeQuery.getEdgeCurveType(edge);
  if (curveType === 'line') {
    return 'line';
  }
  if (curveType === 'circle') {
    return EdgeQuery.isEdgeClosedCurve(edge) ? 'circle' : 'arc';
  }
  return null;
}

/** The dimension the matching filter compares: length, radius or diameter. */
function edgeDimension(edge: Edge): number | null {
  try {
    const kind = classifyEdge(edge);
    if (kind === 'line') {
      return EdgeProps.getProperties(edge.getShape()).length ?? null;
    }
    const circle = EdgeQuery.getCircleDataFromEdge(edge);
    return kind === 'circle' ? circle.radius * 2 : circle.radius;
  } catch {
    return null;
  }
}

function kindBuilder(kind: 'line' | 'arc' | 'circle', dim: number | undefined): EdgeFilterBuilder {
  const builder = new EdgeFilterBuilder();
  if (kind === 'line') {
    return builder.line(dim);
  }
  if (kind === 'arc') {
    return builder.arc(dim);
  }
  return builder.circle(dim);
}

function roundDim(value: number): number {
  return Number(value.toFixed(4));
}

function formatDim(value: number): string {
  return String(value);
}

/** Honest failure message for picks no simple 2D filter can separate. */
function sketchFilterFailureReason(scene: SelectionScene, pool: ResolvedSketchPick[]): string {
  const owner = pool[0].owner;
  const bindFailure = checkSketchBindable(scene, owner);
  if (bindFailure) {
    return `${bindFailure}, and no edge filter distinguishes the picked edges — select them in code directly`;
  }
  return 'no edge filter distinguishes the picked edges from the rest of the sketch — select them in code directly';
}
