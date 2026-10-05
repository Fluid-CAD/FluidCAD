// boolean request validation (create and edit).

import type { BooleanKind, FeatureStatementEditTarget } from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import type { StatementEditRequest } from './statement-edit.ts';

type BooleanRequest = {
  kind: BooleanKind;
  /** The feature statements being combined, in argument order. */
  targets: SketchLoc[];
};

const MAX_BOOLEAN_TARGETS = 16;

/**
 * The boolean request's shape: the kind (fuse/subtract/common) plus the
 * target feature statements addressed by their source locations — a base
 * and a tool for subtract (exactly two, in that order), two or more for
 * fuse and common. No axes, values or picks — the whole statement is its
 * targets.
 */
export function validateBoolean(body: any): BooleanRequest | { error: string } {
  const { kind, targets } = body ?? {};
  if (kind !== 'fuse' && kind !== 'subtract' && kind !== 'common') {
    return { error: 'kind must be "fuse", "subtract" or "common"' };
  }
  if (!Array.isArray(targets) || targets.length < 2 || targets.length > MAX_BOOLEAN_TARGETS) {
    return { error: `targets must be 2-${MAX_BOOLEAN_TARGETS} feature statements to combine` };
  }
  if (kind === 'subtract' && targets.length !== 2) {
    return { error: 'a subtract takes exactly a base and a tool solid' };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the boolean targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  return { kind, targets: targetLocs };
}

export function validateBooleanEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { kind } = body ?? {};
  if (kind !== 'fuse' && kind !== 'subtract' && kind !== 'common') {
    return { error: 'kind must be "fuse", "subtract" or "common"' };
  }
  const result: StatementEditRequest = base;
  edit.boolean = { kind };

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_BOOLEAN_TARGETS) {
      return { error: `targets must be 1-${MAX_BOOLEAN_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['booleanTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const raw of body.targets) {
      if (raw?.kind === 'verbatim') {
        if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(raw.sourceIndex);
        targets.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
      } else if (raw?.kind === 'feature') {
        const loc = validateSketchLoc(raw);
        if (!loc) {
          return { error: 'each re-picked target must be the {filePath, line} of a feature statement' };
        }
        const key = `${loc.filePath}:${loc.line}`;
        if (seenLocs.has(key)) {
          return { error: 'the same feature was picked twice — each target must be different' };
        }
        seenLocs.add(key);
        targets.push({ kind: 'feature', loc });
      } else {
        return { error: 'each target must be {kind: "verbatim"|"feature", …}' };
      }
    }
    if (kind === 'subtract' && targets.length !== 2) {
      return { error: 'a subtract takes exactly a base and a tool solid' };
    }
    result.booleanTargets = targets;
  }
  return result;
}
