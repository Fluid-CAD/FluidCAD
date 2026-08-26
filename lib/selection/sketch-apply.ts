import { SceneObject } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Sketch } from "../features/2d/sketch.js";
import { ShapeFilter } from "../filters/filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { EdgeProps } from "../oc/edge-props.js";
import { WireOps } from "../oc/wire-ops.js";
import { allocateNames, collectImports, renderPartArgs } from "./explain.js";
import { SelectorPart } from "./synthesis.js";
import {
  ApplyFeatureEditSpec,
  ApplyFeatureSynthesis,
  OffsetEditOptions,
  Rotate2DCenterRef,
  Rotate2DEditOptions,
  SelectionScene,
  SynthesizeOptions,
  nameHintFor,
} from "./types.js";

/** A sketch edge pick: 1 shapeId = 1 edge (the Stage 0 emission invariant). */
export type SketchPickRef = { shapeId: string };

export type SketchApplyFeatureKind = 'fillet' | 'offset' | 'text' | 'copy' | 'rotate2d';

/**
 * The rotate dialog's payload as the route hands it in: the center is a
 * literal point or a picked-point reference (P8) still addressed by source
 * line — synthesis resolves the reference to a bound producer + accessor.
 */
export type SketchRotate2DOptions = {
  center: [number | string, number | string] | Rotate2DCenterRef;
  copy: boolean;
};

export type SketchSynthesizeOptions = SynthesizeOptions & {
  /**
   * Offset only: the dialog's `.close()` toggle.
   */
  offset?: OffsetEditOptions;
  /**
   * Slot-from-edge only: the dialog's Remove-original toggle — the call's
   * `deleteSource` argument, whose kernel default is true.
   */
  /** In-sketch rotate only: the dialog's center point and copy toggle. */
  rotate2d?: SketchRotate2DOptions;
  /**
   * 2D copy only: one pick per edge-picked direction, in direction order.
   * Each resolves to its producing single-line geometry, referenced as
   * `axis(<var>)` in the emitted statement. `refs` is the target pick set —
   * it may be empty for an edit that re-picks only the axis.
   */
  axisRefs?: SketchPickRef[];
};

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
  options: SketchSynthesizeOptions = {},
): ApplyFeatureSynthesis {
  // Copy alone tolerates an empty target set: an edit may re-pick only its
  // axis edge while the statement's own targets stand verbatim.
  if (refs.length === 0 && !(feature === 'copy' && (options.axisRefs?.length ?? 0) > 0)) {
    return { ok: false, reason: 'nothing selected' };
  }

  if (feature === 'copy') {
    return synthesizeSketchCopy(scene, refs, options);
  }

  if (feature === 'rotate2d') {
    return synthesizeSketchRotate(scene, refs, value, options);
  }

  if (feature === 'text') {
    return synthesizeSketchTextPath(scene, refs, options);
  }

  const resolution = resolvePicks(scene, refs);
  if ('reason' in resolution) {
    return { ok: false, reason: resolution.reason };
  }
  const { sketch, picks } = resolution;

  // 2D fillet rounds the corners WITHIN the picked group (Fillet2D wires up
  // connected runs and fillets their shared vertices), so a selection with no
  // touching edges would apply as a silent no-op — surface that here instead,
  // for the preview and the apply alike. Adjacency uses the same
  // size-proportional tolerance the build chains with: hand-drawn corners
  // routinely miss by a few hundredths while looking exactly shared.
  if (feature === 'fillet') {
    const pickedEdges = picks.map(p => p.edge);
    const groups = WireOps.groupConnectedEdges(pickedEdges, WireOps.connectTolerance(pickedEdges));
    if (!groups.some(g => g.length >= 2)) {
      return {
        ok: false,
        reason: picks.length === 1
          ? 'a single edge has no corner to fillet — pick two or more adjacent edges'
          : 'the picked edges do not touch — 2D fillet rounds corners between adjacent edges',
      };
    }
  }

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
    offset: feature === 'offset' ? offsetOptions(options) : undefined,
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
    preview: sketchStatementPreview(feature, value, args, spec.offset),
    args,
    alternatives,
  };
}

/** The offset toggle, defaulted — an absent payload is the plain offset. */
function offsetOptions(options: SketchSynthesizeOptions): OffsetEditOptions {
  return {
    close: options.offset?.close === true,
  };
}

/**
 * The statement the transform will write, for the dialog's preview line.
 * Offset caps with `.close()`.
 */
function sketchStatementPreview(
  feature: SketchApplyFeatureKind,
  value: number | string | undefined,
  args: string,
  offset: OffsetEditOptions | undefined,
): string {
  if (value === undefined) {
    return `${feature}(${args})`;
  }
  return `${feature}(${value}, ${args})${offset?.close ? '.close()' : ''}`;
}

/**
 * Resolve owner-level picks (slot/tArc/aLine/text): every picked edge stands
 * for its producing primitive, which must be ONE bindable owner. Guides are
 * included — construction geometry is a classic reference target.
 */
function resolveSingleOwner(
  scene: SelectionScene,
  refs: SketchPickRef[],
  reasonForMany: string,
): { owner: SceneObject } | { reason: string } {
  const resolution = resolvePicks(scene, refs, { includeGuides: true });
  if ('reason' in resolution) {
    return { reason: resolution.reason };
  }

  const owners: SceneObject[] = [];
  for (const pick of resolution.picks) {
    if (!owners.includes(pick.owner)) {
      owners.push(pick.owner);
    }
  }
  if (owners.length > 1) {
    return { reason: reasonForMany };
  }
  const owner = owners[0];
  const bindFailure = checkSketchBindable(scene, owner);
  if (bindFailure) {
    return { reason: bindFailure };
  }
  return { owner };
}

/**
 * The one-bound-producer / bare-variable spec the owner-level features share:
 * the owner's statement binds to a variable and the emitted argument is that
 * variable, verbatim.
 */
function singleOwnerSpec(
  feature: SketchApplyFeatureKind,
  owner: SceneObject,
  options: SketchSynthesizeOptions,
  value?: number | string,
): { spec: ApplyFeatureEditSpec; args: string } {
  const names = allocateNames([owner], options.namer);
  const parts = [part(owner, '', null, null, 0)];
  const args = renderPartArgs(parts[0], names);

  const loc = owner.getSourceLocation()!;
  const spec: ApplyFeatureEditSpec = {
    feature,
    filePath: loc.filePath,
    producers: [{
      line: loc.line,
      column: loc.column,
      featureType: owner.getType(),
      nameHint: nameHintFor(owner.getType()),
      bind: true,
    }],
    parts: parts.map(p => ({
      producer: 0,
      accessor: p.accessor,
      indices: p.indices,
      filterArgs: p.filterArgs,
    })),
    imports: [],
  };
  if (value !== undefined) {
    spec.value = value;
  }
  return { spec, args };
}

/**
 * A text path (`text("Hi", path)`) is owner-level like slot and tArc: the
 * path argument is ONE whole geometry (Text chains ALL of the target's edges
 * into a wire and lays the glyphs along it), so any picked edge stands for
 * its producing primitive and the emitted argument is a bare variable —
 * `text("Hi", c)`. Unlike tArc, multi-edge owners (rect, polygon, slot) are
 * valid paths, as long as their edges chain into one connected run — a
 * disconnected owner would throw at build time, so it is refused here.
 * Guide edges are valid: marking the path `.guide()` is the classic way to
 * keep it out of the extruded profile. The route renders the full statement
 * from the dialog's option values; the synthesis owns only the path argument.
 */
function synthesizeSketchTextPath(
  scene: SelectionScene,
  refs: SketchPickRef[],
  options: SketchSynthesizeOptions,
): ApplyFeatureSynthesis {
  const resolved = resolveSingleOwner(scene, refs, 'text follows one path geometry — pick edges of a single geometry');
  if ('reason' in resolved) {
    return { ok: false, reason: resolved.reason };
  }
  const owner = resolved.owner;

  // Text chains every edge of the path into a single wire; edges that do not
  // connect would fail the build, so refuse them before writing the statement.
  const edges = owner.getShapes({ excludeGuide: false }).filter((s): s is Edge => s instanceof Edge);
  if (edges.length === 0) {
    return { ok: false, reason: `a ${owner.getType()}() has no edges for text to follow` };
  }
  if (WireOps.groupConnectedEdges(edges).length !== 1) {
    return {
      ok: false,
      reason: `the ${owner.getType()}()'s edges do not form one connected path`,
    };
  }

  const { spec, args } = singleOwnerSpec('text', owner, options);
  return {
    ok: true,
    spec,
    preview: `text("…", ${args})`,
    args,
    alternatives: [],
  };
}

/** A resolved center reference: the owning statement + point accessor. */
type ResolvedRotateCenter = {
  owner: SceneObject;
  accessor: 'start' | 'end' | 'center' | 'anchor' | 'point';
  pointIndex?: number;
};

/**
 * Resolve a picked rotation center (a wire ref addressing the point's
 * statement by source line) to its owning statement and the accessor the
 * emitted argument renders — `l.end()`, `c.center()`, `p.start()`,
 * `el.center()`, `t.anchor()`, `bz.point(i)`. Points the statement grammar
 * cannot name (reference outputs, copy duplicates) are refused honestly.
 */
function resolveRotateCenter(
  scene: SelectionScene,
  ref: Rotate2DCenterRef,
  filePath: string,
): ResolvedRotateCenter | { reason: string } {
  const matches = scene.getAllSceneObjects().filter(o => {
    const loc = o.getSourceLocation();
    return loc != null && loc.line === ref.line && loc.filePath === filePath
      && (ref.featureType === undefined || o.getType() === ref.featureType);
  });
  if (matches.length !== 1) {
    return { reason: `the rotation center's statement at line ${ref.line} does not resolve to one sketch primitive` };
  }
  const owner = matches[0];
  const bindFailure = checkSketchBindable(scene, owner);
  if (bindFailure) {
    return { reason: bindFailure };
  }
  const type = owner.getType();
  if (type === 'ellipse') {
    return { owner, accessor: 'center' };
  }
  if (type === 'text') {
    return { owner, accessor: 'anchor' };
  }
  if (type === 'bezier') {
    if (!Number.isInteger(ref.pointIndex) || ref.pointIndex! < 0) {
      return { reason: 'a bezier rotation center needs its control-point index' };
    }
    return { owner, accessor: 'point', pointIndex: ref.pointIndex };
  }
  if (type === 'point') {
    return { owner, accessor: 'start' };
  }
  if (ref.role === 'start' || ref.role === 'end' || ref.role === 'center') {
    return { owner, accessor: ref.role };
  }
  return { reason: 'this point cannot anchor a rotation — pick an endpoint, a center point, a point, or the origin' };
}

/** The center argument's rendered expression for a resolved reference. */
function renderRotateCenterExpr(center: ResolvedRotateCenter, name: string): string {
  return `${name}.${center.accessor}(${center.accessor === 'point' ? center.pointIndex : ''})`;
}

/**
 * The in-sketch rotate is owner-level like the 2D copy: its targets are
 * whole geometries, so any picked edge stands for its producing primitive
 * and the emitted target args are bare variables — `rotate(45, [x, y],
 * r, c)`. The angle and center come from the dialog (options.rotate2d),
 * not the picks; a picked center (P8) resolves to a bound producer's point
 * accessor — `rotate(45, l.end(), r, c)` — riding the same binding rail as
 * the targets. Owners that cannot bind to a variable (clones, loops) are
 * refused honestly.
 */
function synthesizeSketchRotate(
  scene: SelectionScene,
  refs: SketchPickRef[],
  value: number | string | undefined,
  options: SketchSynthesizeOptions,
): ApplyFeatureSynthesis {
  const resolution = resolvePicks(scene, refs);
  if ('reason' in resolution) {
    return { ok: false, reason: resolution.reason };
  }

  const owners: SceneObject[] = [];
  for (const pick of resolution.picks) {
    if (!owners.includes(pick.owner)) {
      owners.push(pick.owner);
    }
  }
  for (const owner of owners) {
    const bindFailure = checkSketchBindable(scene, owner);
    if (bindFailure) {
      return { ok: false, reason: bindFailure };
    }
  }

  const filePaths = new Set(owners.map(o => o.getSourceLocation()!.filePath));
  if (filePaths.size > 1) {
    return { ok: false, reason: 'the picked edges come from statements in different files' };
  }
  const filePath = filePaths.values().next().value!;

  const rt = options.rotate2d;
  let center: ResolvedRotateCenter | null = null;
  if (rt && !Array.isArray(rt.center)) {
    const resolved = resolveRotateCenter(scene, rt.center, filePath);
    if ('reason' in resolved) {
      return { ok: false, reason: resolved.reason };
    }
    center = resolved;
  }

  // The center's statement binds like a target's — one producer list, the
  // center owner appended when it is not already a target.
  const producers = [...owners];
  if (center && !producers.includes(center.owner)) {
    producers.push(center.owner);
  }

  const names = allocateNames(producers, options.namer);
  const parts = owners.map(owner => part(owner, '', null, null, 0));
  const args = parts.map(p => renderPartArgs(p, names)).join(', ');
  const centerExpr = rt === undefined
    ? undefined
    : center
      ? renderRotateCenterExpr(center, names.get(center.owner)!)
      : `[${(rt.center as [number | string, number | string])[0]}, ${(rt.center as [number | string, number | string])[1]}]`;

  const rotate2d: Rotate2DEditOptions | undefined = rt === undefined
    ? undefined
    : {
      copy: rt.copy,
      center: center
        ? {
          producer: producers.indexOf(center.owner),
          accessor: center.accessor,
          ...(center.pointIndex !== undefined ? { pointIndex: center.pointIndex } : {}),
        }
        : rt.center as [number | string, number | string],
    };

  const spec: ApplyFeatureEditSpec = {
    feature: 'rotate2d',
    // The transform validates a nonzero angle — a spec without it is refused
    // wholesale, so the value must ride here, not just the route's preview.
    value,
    filePath,
    producers: producers.map(owner => {
      const loc = owner.getSourceLocation()!;
      return {
        line: loc.line,
        column: loc.column,
        featureType: owner.getType(),
        nameHint: nameHintFor(owner.getType()),
        bind: true,
      };
    }),
    parts: parts.map(p => ({
      producer: producers.indexOf(p.producer!),
      accessor: p.accessor,
      indices: p.indices,
      filterArgs: p.filterArgs,
    })),
    imports: [],
    rotate2d,
  };

  const preview = `rotate(<angle>, ${centerExpr ?? '[0, 0]'}${rt?.copy ? ', true' : ''}, ${args})`;
  return {
    ok: true,
    spec,
    preview,
    args,
    alternatives: [],
    ...(centerExpr !== undefined ? { centerExpr } : {}),
  };
}

/**
 * The 2D copy is owner-level: its targets are whole
 * geometries (CopyLinear2D/CopyCircular2D filter their previous siblings by
 * identity), so any picked edge stands for its producing primitive and the
 * emitted target args are bare variables — `copy('linear', local('x'),
 * {…}, r, c)`. An edge-picked direction resolves the same way, but its owner
 * must be a single straight line (the direction the copy walks), referenced
 * as `axis(<var>)`. The route owns the statement's option payload; this
 * synthesis owns the operands, reporting them through `copySlots` — whose
 * absence tells the route the workspace kernel predates the kind.
 */
function synthesizeSketchCopy(
  scene: SelectionScene,
  refs: SketchPickRef[],
  options: SketchSynthesizeOptions,
): ApplyFeatureSynthesis {
  const axisRefs = options.axisRefs ?? [];

  // One resolution over both slots keeps the same-sketch rule airtight.
  const resolution = resolvePicks(scene, [...refs, ...axisRefs]);
  if ('reason' in resolution) {
    return { ok: false, reason: resolution.reason };
  }

  const targetIds = new Set(refs.map(r => r.shapeId));
  const targetOwners: SceneObject[] = [];
  for (const pick of resolution.picks) {
    if (targetIds.has(pick.ref.shapeId) && !targetOwners.includes(pick.owner)) {
      targetOwners.push(pick.owner);
    }
  }

  // Each direction's pick resolves independently — two directions may pick
  // the same line, and a target may double as an axis.
  const axisOwners: SceneObject[] = [];
  for (const ref of axisRefs) {
    const pick = resolution.picks.find(p => p.ref.shapeId === ref.shapeId);
    if (!pick) {
      return { ok: false, reason: 'an axis pick does not resolve to a sketch edge in the current scene' };
    }
    // The direction is the picked line's own: the kernel resolves
    // `axis(<var>)` through the owner's edge, so it must be exactly one
    // straight segment — an arc or a multi-edge owner has no single direction.
    const shapes = pick.owner.getShapes({ excludeGuide: false });
    const edges = shapes.filter((s): s is Edge => s instanceof Edge);
    if (edges.length !== 1 || shapes[0] !== edges[0] || classifyEdge(edges[0]) !== 'line') {
      return {
        ok: false,
        reason: `a copy direction follows a single straight line — not a ${pick.owner.getType()}()`,
      };
    }
    axisOwners.push(pick.owner);
  }

  const owners: SceneObject[] = [...targetOwners];
  for (const owner of axisOwners) {
    if (!owners.includes(owner)) {
      owners.push(owner);
    }
  }
  for (const owner of owners) {
    const bindFailure = checkSketchBindable(scene, owner);
    if (bindFailure) {
      return { ok: false, reason: bindFailure };
    }
  }

  const filePaths = new Set(owners.map(o => o.getSourceLocation()!.filePath));
  if (filePaths.size > 1) {
    return { ok: false, reason: 'the picked edges come from statements in different files' };
  }

  const names = allocateNames(owners, options.namer);
  const targetParts = targetOwners.map(owner => part(owner, '', null, null, 0));
  const axisParts = axisOwners.map(owner => part(owner, '', null, null, 0));
  const args = targetParts.map(p => renderPartArgs(p, names)).join(', ');

  const spec: ApplyFeatureEditSpec = {
    feature: 'copy',
    filePath: filePaths.values().next().value!,
    producers: owners.map(owner => {
      const loc = owner.getSourceLocation()!;
      return {
        line: loc.line,
        column: loc.column,
        featureType: owner.getType(),
        nameHint: nameHintFor(owner.getType()),
        bind: true,
      };
    }),
    // Only the axis parts ride the spec — the route addresses the targets by
    // producer, matching the copy renderer's contract (every part must be
    // claimed by an axis input).
    parts: axisParts.map(p => ({
      producer: owners.indexOf(p.producer!),
      accessor: p.accessor,
      indices: p.indices,
      filterArgs: p.filterArgs,
    })),
    imports: [],
  };

  return {
    ok: true,
    spec,
    // The route re-renders the full statement around these operands; this
    // preview never reaches a dialog.
    preview: `copy(…, ${args})`,
    args,
    alternatives: [],
    copySlots: {
      targets: targetOwners.map(owner => owners.indexOf(owner)),
      axisParts: axisParts.map((_, i) => i),
    },
  };
}

/** Resolve every `{shapeId}` pick to its edge and owner in ONE sketch. */
function resolvePicks(
  scene: SelectionScene,
  refs: SketchPickRef[],
  options: { includeGuides?: boolean } = {},
): { sketch: Sketch; picks: ResolvedSketchPick[] } | { reason: string } {
  const sketches = scene.getAllSceneObjects()
    .filter((o): o is Sketch => o instanceof Sketch);

  const filter = options.includeGuides ? { excludeGuide: false } : undefined;
  const indexBySketch = new Map<Sketch, Map<string, { edge: Edge; owner: SceneObject }>>();
  for (const sketch of sketches) {
    const byId = new Map<string, { edge: Edge; owner: SceneObject }>();
    for (const [edge, owner] of sketch.getEdgesWithOwner(filter)) {
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

/**
 * One parsed target argument of a 2D statement, ready for resolution — the
 * server parses the statement's argument text into these (it owns the code;
 * this kernel owns the geometry). `line` addresses the producing statement
 * the argument's variable is bound to.
 */
export type SketchTargetDescriptor =
  | { kind: 'owner'; line: number }
  | { kind: 'accessor'; line: number; args: (string | number)[] }
  | { kind: 'filter'; calls: { name: string; dim: number | null }[] };

/**
 * Resolve a 2D statement's target arguments onto the ACTIVE (last) sketch's
 * edges, for edit-dialog seeding: the offset edit pauses the build just
 * before its statement, so the statement's own feature object does not exist
 * in the scene — the targets re-resolve from the argument forms instead,
 * evaluated exactly as the emitted code would (the synthesis evaluators).
 * All-or-nothing: one unresolvable argument yields a refusal, never a
 * silently smaller highlight.
 *
 * `includeGuides` widens the index to construction geometry — a text
 * statement's path is classically a `.guide()` curve; the op targets it
 * seeds by default stay real-edge-only, matching the applies.
 */
export function resolveSketchStatementTargets(
  scene: SelectionScene,
  descriptors: SketchTargetDescriptor[],
  options: { includeGuides?: boolean } = {},
): { ok: true; shapeIds: string[] } | { ok: false; reason: string } {
  const sketches = scene.getAllSceneObjects().filter((o): o is Sketch => o instanceof Sketch);
  const sketch = sketches[sketches.length - 1];
  if (!sketch) {
    return { ok: false, reason: 'no sketch is active' };
  }
  const filter = options.includeGuides ? { excludeGuide: false } : undefined;
  const index = sketch.getEdgesWithOwner(filter);
  const universe = [...index.keys()];
  const knownIds = new Set(universe.map(e => e.id));

  const ownerAt = (line: number): SceneObject | { reason: string } => {
    const owners = [...new Set(index.values())]
      .filter(o => o.getSourceLocation()?.line === line);
    if (owners.length !== 1) {
      return { reason: `the statement at line ${line} does not resolve to one sketch primitive` };
    }
    return owners[0];
  };

  const shapeIds: string[] = [];
  for (const descriptor of descriptors) {
    let edges: Edge[];
    if (descriptor.kind === 'filter') {
      let builder = new EdgeFilterBuilder();
      for (const call of descriptor.calls) {
        if (call.name !== 'line' && call.name !== 'arc' && call.name !== 'circle') {
          return { ok: false, reason: `edge().${call.name}() is not a resolvable edge filter` };
        }
        builder = builder[call.name](call.dim ?? undefined);
      }
      edges = new ShapeFilter(universe, builder).apply() as Edge[];
    } else {
      const owner = ownerAt(descriptor.line);
      if ('reason' in owner) {
        return { ok: false, reason: owner.reason };
      }
      const ownerEdges = owner.getShapes(filter).filter((s): s is Edge => s instanceof Edge);
      if (descriptor.kind === 'owner') {
        edges = ownerEdges;
      } else if (typeof descriptor.args[0] === 'string') {
        const roleIndex = typeof descriptor.args[1] === 'number' ? descriptor.args[1] : undefined;
        edges = evaluateRoleAccessor(ownerEdges, descriptor.args[0], roleIndex);
      } else if (typeof descriptor.args[0] === 'number') {
        edges = evaluateEdgeAccessor(ownerEdges, descriptor.args[0]);
      } else {
        return { ok: false, reason: 'an edge accessor has an argument shape the dialog cannot resolve' };
      }
    }
    if (edges.length === 0 || !edges.every(e => knownIds.has(e.id))) {
      return { ok: false, reason: 'a target argument resolves to no pickable sketch edge' };
    }
    for (const edge of edges) {
      if (!shapeIds.includes(edge.id)) {
        shapeIds.push(edge.id);
      }
    }
  }
  return { ok: true, shapeIds };
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
 * The owner's real edges as originally built, including edges later consumed
 * by downstream ops. The bare-variable form anchors to this set: `fillet(2, r)`
 * must keep meaning "all of r as constructed", not "whatever r still owns at
 * this point in the timeline" — otherwise removing an earlier op silently
 * widens the selection.
 */
function ownerAsBuiltEdges(owner: SceneObject): Edge[] {
  return owner.getAddedShapes().filter((s): s is Edge =>
    s instanceof Edge && !s.isMetaShape() && !s.isGuideShape());
}

/**
 * Owner-accessor candidates for one owner's picked edges, best first:
 * bare variable (only when the picks cover the owner's as-built edge set),
 * role accessors (`edge('top')`, `edge('side', 2)`, whole-role `edge('side')`),
 * then build-order indices (`edge(1)`). Every form is verified against the
 * accessor's own resolution (the owner's current edges). When the picks cover
 * everything the owner *still* owns but not its as-built set (some edges were
 * consumed by earlier ops), the bare form still verifies today but is fragile,
 * so it ranks last. Returns null when no form works.
 */
function synthesizeOwnerCandidates(group: OwnerGroup): GroupCandidates | null {
  const owner = group.owner;
  const edges = ownerRealEdges(owner);
  const picked = new Set(group.picks.map(p => p.edge));
  const forms: SelectorPart[][] = [];

  const coversCurrent = picked.size === edges.length && edges.every(e => picked.has(e));
  const asBuilt = ownerAsBuiltEdges(owner);
  const coversAsBuilt = coversCurrent
    && asBuilt.length === edges.length && asBuilt.every(e => picked.has(e));

  if (coversAsBuilt) {
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

  if (coversCurrent && !coversAsBuilt) {
    forms.push([part(owner, '', null, null, 0)]);
  }

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

export function classifyEdge(edge: Edge): 'line' | 'arc' | 'circle' | null {
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
export function edgeDimension(edge: Edge): number | null {
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

export function kindBuilder(kind: 'line' | 'arc' | 'circle', dim: number | undefined): EdgeFilterBuilder {
  const builder = new EdgeFilterBuilder();
  if (kind === 'line') {
    return builder.line(dim);
  }
  if (kind === 'arc') {
    return builder.arc(dim);
  }
  return builder.circle(dim);
}

export function roundDim(value: number): number {
  return Number(value.toFixed(4));
}

export function formatDim(value: number): string {
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
