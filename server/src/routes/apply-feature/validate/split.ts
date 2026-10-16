// split request validation (create and edit).

import {
  validSplitKeep,
  type FeatureStatementEditTarget,
  type SplitKeep,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick } from '../picks.ts';
import type { RepeatPlaneInput } from './repeat.ts';
import type { StatementEditRequest } from './statement-edit.ts';

/**
 * The split dialog's cut: the mirror's three plane inputs, plus a sketched
 * edge — a line (its plane) or a curve (its sheet): the edge statement's
 * call site inside its sketch, with the sketch statement's own call site so
 * the export can bind and extend it.
 */
export type SplitPlaneInput =
  | RepeatPlaneInput
  | { kind: 'sketchEdge'; sketch: SketchLoc; line: SketchLoc };

export type SplitRequest = {
  /** The feature statements being split, in argument order; empty splits every solid in scope. */
  targets: SketchLoc[];
  plane: SplitPlaneInput;
  keep: SplitKeep;
  /** The file the statement lands in — required for a standard plane with no targets, which pins no scope. */
  filePath: string;
};

export const MAX_SPLIT_TARGETS = 16;

function validatePlaneInput(raw: any, filePath: string, label: string): SplitPlaneInput | { error: string } {
  if (raw?.kind === 'standard') {
    if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
      return { error: `a standard ${label} plane must be "xy", "xz" or "yz"` };
    }
    return { kind: 'standard', plane: raw.plane };
  }
  if (raw?.kind === 'plane') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a plane input must carry the plane {filePath, line}' };
    }
    if (loc.filePath !== filePath) {
      return { error: `the ${label} plane and the statement live in different files` };
    }
    return { kind: 'plane', loc };
  }
  if (raw?.kind === 'face') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'face') {
      return { error: `a picked ${label} plane must carry a {shapeId, sub:{type:"face", index}} pick` };
    }
    return { kind: 'face', pick };
  }
  if (raw?.kind === 'sketchEdge') {
    const sketch = validateSketchLoc(raw.sketch);
    const line = validateSketchLoc(raw.line);
    if (!sketch || !line) {
      return { error: 'a seed line must carry its line {filePath, line, column} and its sketch {filePath, line, column}' };
    }
    if (sketch.filePath !== filePath || line.filePath !== filePath) {
      return { error: `the ${label} seed line and the statement live in different files` };
    }
    if (line.line <= sketch.line) {
      return { error: 'the seed line must be a statement inside the sketch callback' };
    }
    return { kind: 'sketchEdge', sketch, line };
  }
  return { error: 'plane must be {kind: "standard"|"plane"|"face"|"sketchEdge", …}' };
}

function validateOptions(body: any): { keep: SplitKeep } | { error: string } {
  const { keep } = body ?? {};
  if (keep !== undefined && !validSplitKeep(keep)) {
    return { error: 'keep must be "both", "front" or "back"' };
  }
  return { keep: keep ?? 'both' };
}

/**
 * The split request's shape: zero or more target feature statements by
 * source location (none for every solid in scope), the cut (a standard
 * origin plane, an existing plane feature, a picked face, or a sketched
 * line) and the side to keep.
 */
export function validateSplit(body: any): SplitRequest | { error: string } {
  const { targets, filePath } = body ?? {};
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { error: 'filePath must name the file the split lands in' };
  }
  const targetLocs: SketchLoc[] = [];
  if (targets !== undefined && targets !== null) {
    if (!Array.isArray(targets) || targets.length > MAX_SPLIT_TARGETS) {
      return { error: `targets must be 0-${MAX_SPLIT_TARGETS} feature statements to split` };
    }
    const seen = new Set<string>();
    for (const raw of targets) {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'each target must be the {filePath, line} of a feature statement' };
      }
      if (loc.filePath !== filePath) {
        return { error: 'the split targets live in a different file than the statement' };
      }
      const key = `${loc.filePath}:${loc.line}`;
      if (seen.has(key)) {
        return { error: 'the same feature was picked twice — each target must be different' };
      }
      seen.add(key);
      targetLocs.push(loc);
    }
  }
  const plane = validatePlaneInput(body?.plane, filePath, 'split');
  if ('error' in plane) {
    return plane;
  }
  const options = validateOptions(body);
  if ('error' in options) {
    return options;
  }
  return { targets: targetLocs, plane, ...options, filePath };
}

/**
 * The split edit request's shape: keep (the dialog owns the options object
 * outright), the cut — keep, or any create-mode input, a
 * picked face flipping `needsPicks` — and the optional target list mixing
 * `verbatim` keeps with re-picked features; an absent list keeps every
 * statement target, an empty one makes the split implicit.
 */
export function validateSplitEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const options = validateOptions(body);
  if ('error' in options) {
    return options;
  }
  const result: StatementEditRequest = base;
  // The cut defaults to keep; the resolution pass rewrites it (and fills
  // the targets) from the request fields below once producers exist.
  edit.split = { plane: { kind: 'keep' }, keep: options.keep };

  const raw = body?.plane;
  if (raw === undefined || raw === null || raw?.kind === 'keep') {
    result.splitPlane = { kind: 'keep' };
  } else {
    const plane = validatePlaneInput(raw, base.target.filePath, 'split');
    if ('error' in plane) {
      return plane;
    }
    result.splitPlane = plane;
    if (plane.kind === 'face') {
      result.needsPicks = true;
    }
  }

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length > MAX_SPLIT_TARGETS) {
      return { error: `targets must be 0-${MAX_SPLIT_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['splitTargets']> = [];
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
    result.splitTargets = targets;
  }
  return result;
}
