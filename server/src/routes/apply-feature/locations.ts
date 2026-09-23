// Source locations ({filePath, line, column}) and the scope target lists built from them.

import { normalizePath } from '../../normalize-path.ts';

/** A sketch addressed by the source location the scene render reported. */
export type SketchLoc = { filePath: string; line: number; column: number };

export function validateSketchLoc(loc: any): SketchLoc | null {
  const valid = loc && typeof loc.filePath === 'string' && loc.filePath.length > 0
    && Number.isInteger(loc.line) && loc.line >= 1;
  if (!valid) {
    return null;
  }
  return {
    filePath: loc.filePath,
    line: loc.line,
    column: Number.isInteger(loc.column) && loc.column >= 0 ? loc.column : 0,
  };
}

/** How many solid statements a `.scope(…)` chain can name. */
export const MAX_SCOPE_TARGETS = 16;

/**
 * Validate a create request's `scope` list — 0-16 distinct solid-statement
 * locations (whole-solid picks) that render as the `.scope(…)` chain. Shared
 * by every feature dialog that writes one (rib, extrude, sweep, loft,
 * revolve). `op` gates the boolean-only features: `.new()` resets the fusion
 * scope, so a separate body cannot carry one (rib passes null — its scope
 * also drives conforming and composes with `.new()`).
 */
export function validateScopeLocs(
  body: any,
  op: 'add' | 'remove' | 'new' | null = null,
): { scope: SketchLoc[] } | { error: string } {
  const rawScope = body?.scope ?? [];
  if (!Array.isArray(rawScope) || rawScope.length > MAX_SCOPE_TARGETS) {
    return { error: `scope must be 0-${MAX_SCOPE_TARGETS} solid statements` };
  }
  if (op === 'new' && rawScope.length > 0) {
    return { error: 'a separate body (op "new") takes no scope — the scope narrows the boolean operation' };
  }
  const scope: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of rawScope) {
    const target = validateSketchLoc(raw);
    if (!target) {
      return { error: 'each scope target must be the {filePath, line} of a solid statement' };
    }
    const key = `${target.filePath}:${target.line}`;
    if (seen.has(key)) {
      return { error: 'the same solid was picked twice — each scope target must be different' };
    }
    seen.add(key);
    scope.push(target);
  }
  return { scope };
}

/**
 * The cross-file guard every scope-carrying create arm runs: scope solids
 * must live in the statement's own file (their bound variables are
 * referenced from it).
 */
export function scopeCrossFileError(scope: SketchLoc[], filePath: string): string | null {
  for (const loc of scope) {
    if (normalizePath(loc.filePath) !== normalizePath(filePath)) {
      return 'a scope solid comes from a different file than the feature inputs';
    }
  }
  return null;
}

/** One edited scope target: keep by source index, or a re-picked solid statement. */
export type EditScopeTargetInput = { kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc };

/**
 * Validate an edit request's `scope` field. The field owns the `.scope(…)`
 * chain outright when present: an empty list drops the statement's chain
 * (back to whole-scene fusion); absent (`scope: undefined` in the result)
 * keeps it verbatim. Kept targets travel by their `sourceIndex` into the
 * statement's own argument list, re-picked solids by call site. Shared by
 * every feature dialog that writes the chain (rib, extrude, sweep, loft,
 * revolve).
 */
export function validateScopeEdits(body: any): { scope: EditScopeTargetInput[] | undefined } | { error: string } {
  if (body?.scope === undefined || body?.scope === null) {
    return { scope: undefined };
  }
  if (!Array.isArray(body.scope) || body.scope.length > MAX_SCOPE_TARGETS) {
    return { error: `scope must be 0-${MAX_SCOPE_TARGETS} kept or re-picked solid statements` };
  }
  const scope: EditScopeTargetInput[] = [];
  const seenIndices = new Set<number>();
  const seenLocs = new Set<string>();
  for (const raw of body.scope) {
    if (raw?.kind === 'verbatim') {
      if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
        return { error: 'each kept scope target must carry a distinct {sourceIndex} into the statement' };
      }
      seenIndices.add(raw.sourceIndex);
      scope.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
    } else if (raw?.kind === 'feature') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'each re-picked scope target must be the {filePath, line} of a solid statement' };
      }
      const key = `${loc.filePath}:${loc.line}`;
      if (seenLocs.has(key)) {
        return { error: 'the same solid was picked twice — each scope target must be different' };
      }
      seenLocs.add(key);
      scope.push({ kind: 'feature', loc });
    } else {
      return { error: 'each scope target must be {kind: "verbatim"|"feature", …}' };
    }
  }
  return { scope };
}
