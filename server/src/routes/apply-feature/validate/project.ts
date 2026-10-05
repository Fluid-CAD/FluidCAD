// project request validation: the sketch list and its refusals.

import { normalizePath } from '../../../normalize-path.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';

/**
 * The previous sketches a projection references whole (`project(s1)`), as
 * `{filePath, line, column}` call sites: absent or empty means none; each
 * entry must be a valid call site, and duplicates fold to one. Capped to
 * keep a request bounded. Null when the shape is wrong.
 */
export const MAX_PROJECT_SKETCHES = 32;

export function validateProjectSketches(raw: unknown): SketchLoc[] | null {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_PROJECT_SKETCHES) {
    return null;
  }
  const seen = new Set<string>();
  const locs: SketchLoc[] = [];
  for (const entry of raw) {
    const loc = validateSketchLoc(entry);
    if (!loc) {
      return null;
    }
    const key = `${normalizePath(loc.filePath)}:${loc.line}:${loc.column}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    locs.push(loc);
  }
  return locs;
}

/**
 * Why a sketch cannot be a projection source in `receiver`'s sketch, or null
 * when it can: it must live in the receiver's file (the statement binds its
 * variable from inside the sketch body), must not be the receiving sketch
 * itself, and must belong to the receiver's own part (a sketch has no
 * expose() rail — cross-part projection is for solids).
 */
export function projectSketchRefusal(
  loc: SketchLoc,
  receiver: SketchLoc,
  consumer: { partName: string; filePath: string; line: number } | null,
  resolvePart: ((loc: SketchLoc) => { partName: string; filePath: string; line: number } | null) | undefined,
): string | null {
  if (normalizePath(loc.filePath) !== normalizePath(receiver.filePath)) {
    return 'the picked sketch lives in a different file than the sketch';
  }
  if (loc.line === receiver.line) {
    return 'a sketch cannot project itself — pick a previous sketch';
  }
  const owner = resolvePart?.(loc) ?? null;
  const ownerKey = owner ? `${normalizePath(owner.filePath)}:${owner.line}` : null;
  const consumerKey = consumer ? `${normalizePath(consumer.filePath)}:${consumer.line}` : null;
  if (ownerKey !== consumerKey) {
    const name = owner ? `"${owner.partName}"` : 'the top level';
    return `the picked sketch belongs to another part (${name}) — only sketches of the sketch's own part can be projected`;
  }
  return null;
}
