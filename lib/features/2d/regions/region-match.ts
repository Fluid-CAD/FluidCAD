// Resolving what `.region(...)` asked for against the regions a sketch has
// now — the part that survives edits.
//
// A key written by the UI lists every half-edge of the region's outer loop.
// After the sketch changes, the same region may carry a different loop: a
// line drawn across it took part of its boundary, an entity it touched was
// deleted, a new hole gave it an inner loop (which never counts). So a key
// is matched like other CAD systems match a profile:
//
//   1. exactly — the loop is what it was;
//   2. as a subset — every item the key names bounds exactly one region
//      (a hand-written `'c1'` for the disc, an old key for a region that
//      only grew);
//   3. by best overlap — the region sharing most of the key's boundary,
//      when that region is clearly ahead (at least half in common, and no
//      runner-up as close);
//   4. otherwise the region is lost: the error names the nearest keys, so
//      the fix is a re-pick or a copy from the message.
//
// An integer selects by canonical position instead — quick to type, but it
// is a position, not an identity.

import { SketchRegion } from "./region-builder.js";
import { RegionKeyError, RegionKeyItem, itemCovers, parseRegionKey } from "./region-key.js";

export type RegionRequest = string | number;

export type RegionResolution = {
  /** The regions found, in the order they were asked for, without repeats. */
  selected: SketchRegion[];
  /** One sentence per request that did not resolve. */
  problems: string[];
};

/** The overlap a best-match needs to count as the same region. */
const MIN_OVERLAP = 0.5;

export function resolveRegions(requests: RegionRequest[], regions: SketchRegion[]): RegionResolution {
  const selected: SketchRegion[] = [];
  const problems: string[] = [];
  const take = (region: SketchRegion) => {
    if (!selected.includes(region)) {
      selected.push(region);
    }
  };

  for (const request of requests) {
    if (typeof request === 'number') {
      const region = Number.isInteger(request) ? regions[request] : undefined;
      if (region) {
        take(region);
      } else {
        problems.push(`region(${request}): the sketch has ${describeCount(regions.length)}, numbered from 0`);
      }
      continue;
    }

    let items: RegionKeyItem[];
    try {
      items = parseRegionKey(request);
    } catch (error) {
      problems.push(error instanceof RegionKeyError ? error.message : String(error));
      continue;
    }

    const match = matchKey(items, regions);
    if (match.region) {
      take(match.region);
    } else {
      problems.push(match.problem!);
    }
  }

  return { selected, problems };
}

type Scored = { region: SketchRegion; named: number; covered: number; score: number };

function matchKey(items: RegionKeyItem[], regions: SketchRegion[]): { region?: SketchRegion; problem?: string } {
  const text = items.map(i => [i.entity, ...i.path].join('.') + (i.right ? '-' : '')).join(' ');
  if (regions.length === 0) {
    return { problem: `region '${text}': the sketch has no closed regions` };
  }

  const scored: Scored[] = regions.map(region => score(items, region));

  const exact = scored.filter(s => s.named === items.length && s.covered === region_size(s.region));
  if (exact.length === 1) {
    return { region: exact[0].region };
  }

  const subset = scored.filter(s => s.named === items.length);
  if (subset.length === 1) {
    return { region: subset[0].region };
  }
  if (subset.length > 1) {
    return {
      problem: `region '${text}' is ambiguous — it lies on ${subset.length} regions: `
        + subset.map(s => `'${s.region.key}'`).join(', '),
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
      problem: `region '${text}' not found — none of its entities bound a region now. Regions: `
        + regions.map(r => `'${r.key}'`).join(', '),
    };
  }
  if (runnerUp && runnerUp.score === best.score && best.score >= MIN_OVERLAP) {
    return {
      problem: `region '${text}' now matches ${nearest.length} regions equally well — pick one: `
        + nearest.map(s => `'${s.region.key}'`).join(', '),
    };
  }
  return {
    problem: `region '${text}' not found — its boundary changed too much. Nearest: `
      + nearest.map(s => `'${s.region.key}' (${Math.round(s.score * 100)}%)`).join(', '),
  };
}

/**
 * How well a key describes a region: `named` counts the key's items that
 * lie on the region, `covered` the region's half-edges the key names, and
 * `score` their Jaccard overlap.
 */
function score(items: RegionKeyItem[], region: SketchRegion): Scored {
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

function region_size(region: SketchRegion): number {
  return region.items.length;
}

function describeCount(n: number): string {
  return n === 1 ? '1 region' : `${n} regions`;
}
