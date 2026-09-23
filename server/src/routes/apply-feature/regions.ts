// Region keys (.region(...)) and their limits.

import type { RegionKey } from '../../apply-feature-edit/index.ts';

/** How many regions a `.region(…)` chain can name — a dialog pick list, not a bulk API. */
export const MAX_REGION_KEYS = 64;

/** The longest key a pick writes; a sketch loop of that many statements is already hand-written territory. */
const MAX_REGION_KEY_LENGTH = 512;

/**
 * One `.region(…)` argument off the wire: a key string (the grammar is the
 * kernel's to check — an unparseable key becomes the feature's error) or a
 * non-negative integer position. Null for anything else.
 */
function validateRegionKey(raw: unknown): RegionKey | null {
  if (typeof raw === 'string') {
    return raw.length > 0 && raw.length <= MAX_REGION_KEY_LENGTH ? raw : null;
  }
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  return null;
}

/**
 * A request's `regions` field as a key list: absent reads as the empty list
 * (no `.region()` chain — every region builds). Shared by the create paths
 * of every swept feature (extrude, sweep, revolve, wrap).
 */
export function validateRegionKeys(body: any): { regions: RegionKey[] } | { error: string } {
  const raw = body?.regions ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_REGION_KEYS) {
    return { error: `regions must be 0-${MAX_REGION_KEYS} region keys` };
  }
  const regions: RegionKey[] = [];
  for (const entry of raw) {
    const key = validateRegionKey(entry);
    if (key === null) {
      return { error: 'each region must be a key string or a non-negative region number' };
    }
    if (regions.includes(key)) {
      return { error: 'the same region was picked twice — each region key must be different' };
    }
    regions.push(key);
  }
  return { regions };
}

/**
 * An edit request's `regions` field. The field owns the `.region(…)` chain
 * outright when present: an empty list drops the statement's chain (back
 * to every region); absent (`regions: undefined` in the result) keeps it
 * verbatim. Shared by every swept-feature dialog.
 */
export function validateRegionEdits(body: any): { regions: RegionKey[] | undefined } | { error: string } {
  if (body?.regions === undefined || body?.regions === null) {
    return { regions: undefined };
  }
  return validateRegionKeys(body);
}
