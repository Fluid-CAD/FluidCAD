// translate request validation (create and edit).

import {
  validTranslation,
  type FeatureStatementEditTarget,
  type TranslationSpec,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import type { StatementEditRequest } from './statement-edit.ts';

type TranslateRequest = {
  /** The feature statements being moved, in argument order. */
  targets: SketchLoc[];
  /** The distance along X, Y and Z. */
  translation: TranslationSpec;
  /** Keep the originals in place — the `true` after the distances. */
  copy: boolean;
};

export const MAX_TRANSLATE_TARGETS = 16;

const TRANSLATION_ERROR = 'translation must be [x, y, z] distances that are not all zero';

/**
 * The translate request's shape: one or more target feature statements
 * addressed by their source locations, the distances along X, Y and Z, and
 * the copy flag. The rotate's transform sibling with distances where the
 * axis and angle were — nothing to pick but the solids.
 */
export function validateTranslate(body: any): TranslateRequest | { error: string } {
  const { targets, translation, copy } = body ?? {};
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_TRANSLATE_TARGETS) {
    return { error: `targets must be 1-${MAX_TRANSLATE_TARGETS} feature statements to translate` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (targetLocs.length > 0 && loc.filePath !== targetLocs[0].filePath) {
      return { error: 'the translate targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  if (!validTranslation(translation)) {
    return { error: TRANSLATION_ERROR };
  }
  if (copy !== undefined && typeof copy !== 'boolean') {
    return { error: 'copy must be a boolean' };
  }
  return { targets: targetLocs, translation, copy: copy === true };
}

/**
 * The translate edit request's shape: the distances and copy flag (the dialog
 * owns both outright) and the optional target list mixing `verbatim` keeps
 * with re-picked features; an absent list keeps every statement target.
 */
export function validateTranslateEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { translation, copy } = body ?? {};
  if (!validTranslation(translation)) {
    return { error: TRANSLATION_ERROR };
  }
  if (copy !== undefined && typeof copy !== 'boolean') {
    return { error: 'copy must be a boolean' };
  }
  const result: StatementEditRequest = base;
  // The resolution pass fills the targets from the request field below once
  // producers exist.
  edit.translate = { translation, copy: copy === true };

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_TRANSLATE_TARGETS) {
      return { error: `targets must be 1-${MAX_TRANSLATE_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['translateTargets']> = [];
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
    result.translateTargets = targets;
  }
  return result;
}
