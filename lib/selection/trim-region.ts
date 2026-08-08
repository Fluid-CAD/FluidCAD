import { Edge } from "../common/edge.js";
import { Trim2D } from "../features/trim2d.js";
import { ShapeFilter } from "../filters/filter.js";
import { classifyEdge, edgeDimension, kindBuilder, roundDim, formatDim } from "./sketch-apply.js";
import { SelectionScene } from "./types.js";

export type TrimRegionSynthesis =
  | { ok: true; args: string; imports: string[] }
  | { ok: false; reason: string };

/**
 * Selector synthesis for by-region trimming: a region click arrives as the
 * ids of the split segments bounding the clicked cell (the `trim` meta
 * shapes of the interactive trim statement), and the emitted args are edge
 * filters (`edge().line(80)`) that resolve — against the SAME split-segment
 * universe the rebuilt trim() will produce — to exactly the picked segments.
 * Every candidate is verified by running the composed builders the way the
 * build will; when no filter combination separates the boundary from the
 * surviving segments, the synthesis refuses honestly — region trimming only
 * ever writes filters.
 */
export function synthesizeTrimRegionTargets(
  scene: SelectionScene,
  sourceLocation: { line: number; column?: number },
  edgeIds: string[],
): TrimRegionSynthesis {
  const trim = findTrimAt(scene, sourceLocation);
  if (!trim) {
    return { ok: false, reason: 'no interactive trim statement at that location' };
  }

  const universe = trim.getSegments();
  if (universe.length === 0) {
    return { ok: false, reason: 'the trim has no split segments to select from' };
  }

  const byId = new Map(universe.map(edge => [edge.id, edge]));
  const picks: Edge[] = [];
  for (const id of new Set(edgeIds)) {
    const edge = byId.get(id);
    if (!edge) {
      return { ok: false, reason: 'a region edge does not resolve to a trim segment in the current scene' };
    }
    picks.push(edge);
  }
  if (picks.length === 0) {
    return { ok: false, reason: 'the region has no boundary segments to trim' };
  }

  const args = induceSegmentFilters(universe, picks);
  if (!args) {
    return {
      ok: false,
      reason: 'no edge filter distinguishes the region boundary from the rest of the sketch',
    };
  }
  return { ok: true, args, imports: ['edge'] };
}

function findTrimAt(
  scene: SelectionScene,
  sourceLocation: { line: number; column?: number },
): Trim2D | null {
  for (const obj of scene.getAllSceneObjects()) {
    if (!(obj instanceof Trim2D)) {
      continue;
    }
    const loc = obj.getSourceLocation();
    if (!loc || loc.line !== sourceLocation.line) {
      continue;
    }
    if (sourceLocation.column !== undefined && loc.column !== sourceLocation.column) {
      continue;
    }
    return obj;
  }
  return null;
}

/**
 * One filter-argument list resolving to exactly the picked segments over the
 * split-segment universe: a bare kind filter when the picks are all of one
 * curve kind and nothing else matches, otherwise one dimension-narrowed
 * filter per (kind, dimension) group of the picks. Returns the rendered args
 * or null when some filter would drag an unpicked segment along.
 */
function induceSegmentFilters(universe: Edge[], picks: Edge[]): string | null {
  const pickSet = new Set(picks);

  const kinds = picks.map(classifyEdge);
  if (kinds.some(k => k === null)) {
    return null;
  }
  const kind = kinds[0]!;
  if (kinds.every(k => k === kind)) {
    const bare = `edge().${kind}()`;
    if (resolvesToExactly(universe, kindBuilder(kind, undefined), pickSet)) {
      return bare;
    }
  }

  // Group by (kind, rounded dimension); each group must find a filter whose
  // matches stay inside the picked set, and together they must cover it.
  const groups = new Map<string, Edge[]>();
  for (const pick of picks) {
    const pickKind = classifyEdge(pick)!;
    const dim = edgeDimension(pick);
    if (dim === null) {
      return null;
    }
    const key = `${pickKind}:${roundDim(dim)}`;
    groups.set(key, [...(groups.get(key) ?? []), pick]);
  }

  const rendered: string[] = [];
  const covered = new Set<Edge>();
  for (const members of groups.values()) {
    const memberKind = classifyEdge(members[0])!;
    const dim = edgeDimension(members[0])!;
    let matchedArgs: string | null = null;
    for (const value of [roundDim(dim), dim]) {
      const matches = new ShapeFilter(universe, kindBuilder(memberKind, value)).apply() as Edge[];
      if (matches.length > 0 && matches.every(m => pickSet.has(m))
        && members.every(m => matches.includes(m))) {
        matchedArgs = `edge().${memberKind}(${formatDim(value)})`;
        matches.forEach(m => covered.add(m));
        break;
      }
    }
    if (!matchedArgs) {
      return null;
    }
    if (!rendered.includes(matchedArgs)) {
      rendered.push(matchedArgs);
    }
  }

  if (covered.size !== pickSet.size) {
    return null;
  }
  return rendered.join(', ');
}

function resolvesToExactly(universe: Edge[], builder: ReturnType<typeof kindBuilder>, picks: Set<Edge>): boolean {
  const resolved = new ShapeFilter(universe, builder).apply() as Edge[];
  return resolved.length === picks.size && resolved.every(e => picks.has(e));
}
