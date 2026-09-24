// Region picks (.region(...) and the region() declarations behind it) off the wire, and their limits.

import type { RegionItemRefSpec, RegionPickSpec } from '../../apply-feature-edit/index.ts';

/** How many regions a `.region(…)` chain can name — a dialog pick list, not a bulk API. */
export const MAX_REGION_PICKS = 64;

/** How many entities one picked boundary may list; a sketch loop of that many statements is hand-written territory. */
const MAX_REGION_ITEMS = 256;

const NAME_PATTERN = /^[^\n\r'\\]{1,128}$/;
const CALLEE_PATTERN = /^[A-Za-z_$][\w$]*$/;
const EDGE_PATTERN = /^[\w$]+(?:\.[\w$]+)*$/;

/** One boundary item off the wire, or null for anything malformed. */
function validateRegionItem(raw: unknown): RegionItemRefSpec | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  if (!Number.isInteger(item.line) || (item.line as number) < 1) {
    return null;
  }
  if (item.occurrence !== undefined && (!Number.isInteger(item.occurrence) || (item.occurrence as number) < 0)) {
    return null;
  }
  if (typeof item.callee !== 'string' || !CALLEE_PATTERN.test(item.callee)) {
    return null;
  }
  if (item.edge !== undefined && (typeof item.edge !== 'string' || !EDGE_PATTERN.test(item.edge))) {
    return null;
  }
  if (typeof item.far !== 'boolean') {
    return null;
  }
  return {
    line: item.line as number,
    ...(item.occurrence !== undefined ? { occurrence: item.occurrence as number } : {}),
    callee: item.callee,
    ...(item.edge !== undefined ? { edge: item.edge as string } : {}),
    far: item.far,
  };
}

/**
 * One region pick off the wire: a declared name, a boundary, or both. Null
 * for anything else — the kernel's own checks (a name nobody declared, a
 * boundary no region has) become the feature's error, not a 400.
 */
function validateRegionPick(raw: unknown): RegionPickSpec | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const pick = raw as Record<string, unknown>;
  const out: RegionPickSpec = {};
  if (pick.name !== undefined && pick.name !== null) {
    if (typeof pick.name !== 'string' || !NAME_PATTERN.test(pick.name)) {
      return null;
    }
    out.name = pick.name;
  }
  if (pick.items !== undefined && pick.items !== null) {
    if (!Array.isArray(pick.items) || pick.items.length > MAX_REGION_ITEMS) {
      return null;
    }
    const items: RegionItemRefSpec[] = [];
    for (const entry of pick.items) {
      const item = validateRegionItem(entry);
      if (!item) {
        return null;
      }
      items.push(item);
    }
    out.items = items;
  }
  if (out.name === undefined && (out.items === undefined || out.items.length === 0)) {
    return null;
  }
  return out;
}

/**
 * A request's `regions` field as a pick list: absent reads as the empty list
 * (no `.region()` chain — every region builds). Shared by the create paths
 * of every swept feature (extrude, sweep, revolve, wrap) and the ghost.
 */
export function validateRegionPicks(body: any): { regions: RegionPickSpec[] } | { error: string } {
  const raw = body?.regions ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_REGION_PICKS) {
    return { error: `regions must be 0-${MAX_REGION_PICKS} region picks` };
  }
  const regions: RegionPickSpec[] = [];
  for (const entry of raw) {
    const pick = validateRegionPick(entry);
    if (pick === null) {
      return { error: 'each region pick names a declared region ({name}) and/or its boundary ({items: [{line, callee, far}]})' };
    }
    regions.push(pick);
  }
  return { regions };
}

/**
 * An edit request's `regions` field. The field owns the `.region(…)` chain
 * outright when present: an empty list drops the statement's chain (back
 * to every region); absent (`regions: undefined` in the result) keeps it
 * verbatim. Shared by every swept-feature dialog.
 */
export function validateRegionEdits(body: any): { regions: RegionPickSpec[] | undefined } | { error: string } {
  if (body?.regions === undefined || body?.regions === null) {
    return { regions: undefined };
  }
  return validateRegionPicks(body);
}
