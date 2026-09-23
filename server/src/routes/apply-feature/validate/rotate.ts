// rotate request validation (create and edit).

import {
  validValueExpr,
  type FeatureStatementEditTarget,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validateRevolveAxis, type RevolveAxisInput } from './revolve.ts';
import type { StatementEditRequest } from './statement-edit.ts';

type RotateRequest = {
  /** The feature statements being turned, in argument order. */
  targets: SketchLoc[];
  /** The axis to rotate around — the revolve axis shapes. */
  axis: RevolveAxisInput;
  /** The rotation angle in degrees. */
  angle: ValueExpr;
  /** Keep the originals in place — the `true` third argument. */
  copy: boolean;
};

export const MAX_ROTATE_TARGETS = 16;

/**
 * The rotate request's shape: one or more target feature statements
 * addressed by their source locations, the rotation axis (a standard world
 * axis, an existing axis statement, or a picked edge — the revolve axis's
 * exact input), the angle in degrees, and the copy flag. The transform
 * sibling of {@link validateMirror} with an axis where the plane was.
 */
export function validateRotate(body: any): RotateRequest | { error: string } {
  const { targets, angle, copy } = body ?? {};
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_ROTATE_TARGETS) {
    return { error: `targets must be 1-${MAX_ROTATE_TARGETS} feature statements to rotate` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the rotate targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  const filePath = targetLocs[0].filePath;

  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
    return { error: 'the axis and the targets live in different files' };
  }
  if (!validValueExpr(angle, { nonzero: true })) {
    return { error: 'angle must be a nonzero rotation angle in degrees' };
  }
  if (copy !== undefined && typeof copy !== 'boolean') {
    return { error: 'copy must be a boolean' };
  }
  return { targets: targetLocs, axis, angle, copy: copy === true };
}

/**
 * The rotate edit request's shape: the angle and copy flag (the dialog owns
 * both outright), the axis — keep, or any create-mode axis input, a picked
 * edge flipping `needsPicks` — and the optional target list mixing `verbatim`
 * keeps with re-picked features; an absent list keeps every statement target.
 */
export function validateRotateEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { angle, copy } = body ?? {};
  if (!validValueExpr(angle, { nonzero: true })) {
    return { error: 'angle must be a nonzero rotation angle in degrees' };
  }
  if (copy !== undefined && typeof copy !== 'boolean') {
    return { error: 'copy must be a boolean' };
  }
  const result: StatementEditRequest = base;
  // The axis defaults to keep; the resolution pass rewrites it (and fills
  // the targets) from the request fields below once producers exist.
  edit.rotate = { axis: { kind: 'keep' }, angle, copy: copy === true };

  const raw = body?.axis;
  if (raw === undefined || raw === null || raw?.kind === 'keep') {
    result.rotateAxis = { kind: 'keep' };
  } else {
    const axis = validateRevolveAxis(raw);
    if ('error' in axis) {
      return axis;
    }
    if (axis.kind === 'edge') {
      result.needsPicks = true;
    }
    result.rotateAxis = axis;
  }

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_ROTATE_TARGETS) {
      return { error: `targets must be 1-${MAX_ROTATE_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['rotateTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const rawTarget of body.targets) {
      if (rawTarget?.kind === 'verbatim') {
        if (!Number.isInteger(rawTarget.sourceIndex) || rawTarget.sourceIndex < 0 || seenIndices.has(rawTarget.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(rawTarget.sourceIndex);
        targets.push({ kind: 'verbatim', sourceIndex: rawTarget.sourceIndex });
      } else if (rawTarget?.kind === 'feature') {
        const loc = validateSketchLoc(rawTarget);
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
    result.rotateTargets = targets;
  }
  return result;
}
