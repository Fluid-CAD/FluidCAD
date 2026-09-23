// mirror request validation (create and edit).

import type { FeatureStatementEditTarget } from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, validateSketchPicks } from '../picks.ts';
import type { RepeatPlaneInput } from './repeat.ts';
import type { StatementEditRequest } from './statement-edit.ts';

type MirrorRequest = {
  /** The feature statements being reflected, in argument order. */
  targets: SketchLoc[];
  /** The plane to mirror across — the repeat mirror's plane shapes. */
  plane: RepeatPlaneInput;
  /** How the reflected bodies land: fused (the default), cut, or standalone. */
  op: 'add' | 'remove' | 'new';
};

export const MAX_MIRROR_TARGETS = 16;

/**
 * The mirror request's shape: one or more target feature statements
 * addressed by their source locations, the mirror plane (a standard origin
 * plane, an existing plane feature, or a picked face — the repeat mirror's
 * exact input), and the op the reflected bodies land with. No axes and no
 * numeric options — a mirror is its plane and its targets.
 */
export function validateMirror(body: any): MirrorRequest | { error: string } {
  const { targets, op } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_MIRROR_TARGETS) {
    return { error: `targets must be 1-${MAX_MIRROR_TARGETS} feature statements to mirror` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the mirror targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  const filePath = targetLocs[0].filePath;

  const raw = body?.plane;
  let plane: RepeatPlaneInput;
  if (raw?.kind === 'standard') {
    if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
      return { error: 'a standard mirror plane must be "xy", "xz" or "yz"' };
    }
    plane = { kind: 'standard', plane: raw.plane };
  } else if (raw?.kind === 'plane') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a plane input must carry the plane {filePath, line}' };
    }
    if (loc.filePath !== filePath) {
      return { error: 'the mirror plane and the targets live in different files' };
    }
    plane = { kind: 'plane', loc };
  } else if (raw?.kind === 'face') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'face') {
      return { error: 'a picked mirror plane must carry a {shapeId, sub:{type:"face", index}} pick' };
    }
    plane = { kind: 'face', pick };
  } else {
    return { error: 'plane must be {kind: "standard"|"plane"|"face", …}' };
  }
  return { targets: targetLocs, plane, op };
}

/**
 * The boolean edit request's shape: the kind (an edit may rewrite a fuse
 * into a subtract) plus the optional target list mixing `verbatim` keeps
 * with re-picked feature statements; an absent list keeps every statement
 * target. No axes, values or picks — `needsPicks` never flips.
 */
/**
 * The mirror edit request's shape: the op (the dialog owns the operation
 * chain outright), the plane — keep, or any create-mode plane input, a
 * picked face flipping `needsPicks` — and the optional target list mixing
 * `verbatim` keeps with re-picked features; an absent list keeps every
 * statement target.
 */
export function validateMirrorEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { op } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  const result: StatementEditRequest = base;

  // The 2D in-sketch form: an `axis` field where the plane would be. Its
  // keep re-reads the statement's own line text; a sketch-local axis or a
  // picked line re-sources it, and the targets re-pick as sketch edges. The
  // chain-less kernel form takes no op.
  if (body?.axis !== undefined && body?.axis !== null) {
    if (body?.plane !== undefined && body?.plane !== null) {
      return { error: 'a mirror edit carries a plane (3D) or an axis (2D), not both' };
    }
    if (op !== 'add') {
      return { error: 'an in-sketch mirror takes no operation chain — op must be "add"' };
    }
    if (body?.targets !== undefined && body?.targets !== null) {
      return { error: 'an in-sketch mirror re-picks its targets as sketchTargets' };
    }
    const axis = body.axis;
    if (axis?.kind === 'keep') {
      result.mirrorAxis = { kind: 'keep' };
    } else if (axis?.kind === 'local') {
      if (axis.axis !== 'x' && axis.axis !== 'y') {
        return { error: 'a local axis must be {kind: "local", axis: "x" | "y"}' };
      }
      result.mirrorAxis = { kind: 'local', axis: axis.axis };
    } else if (axis?.kind === 'sketch-edge') {
      result.mirrorAxis = { kind: 'sketch-edge' };
    } else {
      return { error: 'axis must be {kind: "keep"|"local"|"sketch-edge", …}' };
    }
    if (body?.sketchAxisEntities !== undefined && body?.sketchAxisEntities !== null) {
      const picks = validateSketchPicks(body.sketchAxisEntities);
      if (!picks) {
        return { error: 'sketchAxisEntities must be a non-empty array of {shapeId} picks' };
      }
      result.mirrorAxisPicks = picks;
    }
    if ((result.mirrorAxisPicks?.length ?? 0) !== (result.mirrorAxis.kind === 'sketch-edge' ? 1 : 0)) {
      return { error: 'sketchAxisEntities must carry exactly one pick for a sketch-edge axis' };
    }
    if (body?.sketchTargets !== undefined && body?.sketchTargets !== null) {
      const picks = validateSketchPicks(body.sketchTargets);
      if (!picks) {
        return { error: 'sketchTargets must be a non-empty array of {shapeId} picks' };
      }
      if (picks.length > MAX_MIRROR_TARGETS) {
        return { error: `sketchTargets must be 1-${MAX_MIRROR_TARGETS} picks` };
      }
      result.mirrorSketchTargets = picks;
    }
    // The axis defaults to keep; the resolution pass rewrites it (and fills
    // the targets) from the request fields once producers exist.
    edit.mirror = { axis: { kind: 'keep' }, op };
    return result;
  }
  if (body?.sketchTargets !== undefined || body?.sketchAxisEntities !== undefined) {
    return { error: 'sketchTargets and sketchAxisEntities only apply to an in-sketch mirror (axis)' };
  }
  // The plane defaults to keep; the resolution pass rewrites it (and fills
  // the targets) from the request fields below once producers exist.
  edit.mirror = { plane: { kind: 'keep' }, op };

  const raw = body?.plane;
  if (raw === undefined || raw === null || raw?.kind === 'keep') {
    result.mirrorPlane = { kind: 'keep' };
  } else if (raw?.kind === 'standard') {
    if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
      return { error: 'a standard mirror plane must be "xy", "xz" or "yz"' };
    }
    result.mirrorPlane = { kind: 'standard', plane: raw.plane };
  } else if (raw?.kind === 'plane') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a plane input must carry the plane {filePath, line}' };
    }
    result.mirrorPlane = { kind: 'plane', loc };
  } else if (raw?.kind === 'face') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'face') {
      return { error: 'a picked mirror plane must carry a {shapeId, sub:{type:"face", index}} pick' };
    }
    result.mirrorPlane = { kind: 'face', pick };
    result.needsPicks = true;
  } else {
    return { error: 'plane must be {kind: "keep"|"standard"|"plane"|"face", …}' };
  }

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_MIRROR_TARGETS) {
      return { error: `targets must be 1-${MAX_MIRROR_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['mirrorTargets']> = [];
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
    result.mirrorTargets = targets;
  }
  return result;
}
