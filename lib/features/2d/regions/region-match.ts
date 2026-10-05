// Resolving a declared region against the regions a sketch has now — the
// part that survives edits.
//
// A declaration lists the half-edges of the region's outer loop as it was
// picked. After the sketch changes, the same region may carry a different
// loop: a line drawn across it took part of its boundary, an entity it
// touched was deleted (which the declaration reports at compile time, the
// reference being gone), a new hole gave it an inner loop (which never
// counts). So a declaration is matched like other CAD systems match a
// profile:
//
//   1. exactly — the loop is what it was;
//   2. as a subset — every item the declaration names bounds exactly one
//      region (a hand-written `region('disc', c1)`, a region that only grew);
//   3. by best overlap — the region sharing most of the declared boundary,
//      when that region is clearly ahead (at least half in common, and no
//      runner-up as close);
//   4. otherwise the region is lost: the error names the nearest regions in
//      the form a declaration would take, so the fix is a re-pick or a paste.

import type { SketchRegion } from "./region-builder.js";
import { RegionItem, itemCovers } from "./region-ref.js";
import type { StatementLabels } from "./statement-label.js";

/** One way a consumer asks for a region: a declared name, or a boundary given directly. */
export type RegionRequest =
  | { name: string }
  | { name?: string; items: RegionItem[] };

export type RegionResolution = {
  /** The regions found, in the order they were asked for, without repeats. */
  selected: SketchRegion[];
  /** One sentence per request that did not resolve. */
  problems: string[];
};

/** A declaration as the matcher needs it: its name, its items, or why it is unusable. */
export type DeclaredRegion = { name: string; items: RegionItem[]; error: string | null };

/** The overlap a best-match needs to count as the same region. */
const MIN_OVERLAP = 0.5;

/**
 * Resolve the requests: a name looks up the sketch's declaration first; a
 * request carrying its own items (the picker's unnamed picks) matches them
 * directly. Names nobody declared, unusable declarations and boundaries
 * that no longer pin one region each become a problem sentence.
 */
export function resolveRegions(
  requests: RegionRequest[],
  regions: SketchRegion[],
  declarations: Map<string, DeclaredRegion>,
  labels: StatementLabels,
): RegionResolution {
  const selected: SketchRegion[] = [];
  const problems: string[] = [];
  const take = (region: SketchRegion) => {
    if (!selected.includes(region)) {
      selected.push(region);
    }
  };

  for (const request of requests) {
    let items: RegionItem[];
    let label: string;
    if ('items' in request && request.items) {
      items = request.items;
      label = request.name ? `'${request.name}'` : `'${labels.formatItems(items)}'`;
    } else {
      const name = request.name!;
      if (typeof name !== 'string' || name.length === 0) {
        problems.push(`region(${JSON.stringify(name)}): a region is named by the string a region() declaration gave it`);
        continue;
      }
      const declared = declarations.get(name);
      if (!declared) {
        const known = [...declarations.keys()];
        problems.push(`region '${name}' is not declared in the sketch — add region('${name}', …) inside the sketch callback`
          + (known.length > 0 ? `; declared: ${known.map(k => `'${k}'`).join(', ')}` : ''));
        continue;
      }
      if (declared.error) {
        problems.push(`region '${name}': ${declared.error}`);
        continue;
      }
      items = declared.items;
      label = `'${name}'`;
    }

    const match = matchItems(items, regions, labels, label);
    if (match.region) {
      take(match.region);
    } else {
      problems.push(match.problem!);
    }
  }

  return { selected, problems };
}

type Scored = { region: SketchRegion; named: number; covered: number; score: number };

/**
 * The one region a boundary names, or the sentence saying why there is
 * none. `label` is how the request reads in that sentence.
 */
export function matchItems(
  items: RegionItem[],
  regions: SketchRegion[],
  labels: StatementLabels,
  label: string = `'${labels.formatItems(items)}'`,
): { region?: SketchRegion; problem?: string } {
  if (regions.length === 0) {
    return { problem: `region ${label}: the sketch has no closed regions` };
  }
  if (items.length === 0) {
    return { problem: `region ${label} names no entity` };
  }

  const scored: Scored[] = regions.map(region => score(items, region));
  const describe = (s: Scored) => `[${labels.formatItems(s.region.items)}]`;

  const exact = scored.filter(s => s.named === items.length && s.covered === s.region.items.length);
  if (exact.length === 1) {
    return { region: exact[0].region };
  }

  const subset = scored.filter(s => s.named === items.length);
  if (subset.length === 1) {
    return { region: subset[0].region };
  }
  if (subset.length > 1) {
    return {
      problem: `region ${label} is ambiguous — its entities bound ${subset.length} regions; `
        + `add far() to the entities the region lies on the far side of: `
        + subset.map(describe).join(', '),
    };
  }

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best.score >= MIN_OVERLAP && (!runnerUp || runnerUp.score < best.score)) {
    return { region: best.region };
  }

  const nearest = ranked.filter(s => s.score > 0).slice(0, 3);
  if (nearest.length === 0) {
    return {
      problem: `region ${label} not found — none of its entities bound a region now. Regions: `
        + scored.map(describe).join(', '),
    };
  }
  if (runnerUp && runnerUp.score === best.score && best.score >= MIN_OVERLAP) {
    return {
      problem: `region ${label} now matches ${nearest.length} regions equally well — pick one: `
        + nearest.map(describe).join(', '),
    };
  }
  return {
    problem: `region ${label} not found — its boundary changed too much. Nearest: `
      + nearest.map(s => `${describe(s)} (${Math.round(s.score * 100)}%)`).join(', '),
  };
}

/**
 * How well a boundary describes a region: `named` counts the items that
 * lie on the region, `covered` the region's half-edges the items name, and
 * `score` their Jaccard overlap.
 */
function score(items: RegionItem[], region: SketchRegion): Scored {
  let named = 0;
  const coveredSet = new Set<number>();
  for (const item of items) {
    let hit = false;
    region.items.forEach((halfEdge, index) => {
      if (itemCovers(item, halfEdge)) {
        hit = true;
        coveredSet.add(index);
      }
    });
    if (hit) {
      named++;
    }
  }
  const covered = coveredSet.size;
  const union = region.items.length + (items.length - named);
  return { region, named, covered, score: union === 0 ? 0 : covered / union };
}
