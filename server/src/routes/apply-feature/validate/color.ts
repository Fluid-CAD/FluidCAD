// color request validation (create and edit).

import { ColorValues, ValueSlots, type FeatureStatementEditTarget, type TextSlot } from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validateChains, validatePicks, type Pick } from '../picks.ts';
import type { StatementEditRequest } from './statement-edit.ts';

/**
 * A colour create request: the value, then what it paints — whole objects
 * by their statements (the dialog's Solid tab) or picked faces synthesized
 * into selectors (the Face tab), never both.
 */
export type ColorRequest = {
  /** The colour as the statement writes it, or the expression computing it. */
  value: TextSlot;
  paint:
    | { kind: 'solids'; targets: SketchLoc[] }
    | { kind: 'faces'; picks: Pick[]; chains: { seed: Pick; members: Pick[] }[]; selectorOverride?: string };
};

export const MAX_COLOR_TARGETS = 16;

/**
 * The value's refusal, or null when `value` is a colour the statement can
 * write or an expression holding text — shape only: whether an expression
 * may be written is the transform's to say, with the statement's own kept.
 */
function colorValueError(value: unknown): string | null {
  return ValueSlots.shaped(value, ColorValues.valid)
    ? null
    : 'value must be a CSS colour — a hex value, a colour name or an rgb() string — or an expression';
}

function selectorOverrideError(selectorOverride: unknown): string | null {
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    return 'selectorOverride must be a non-empty string (max 500 chars)';
  }
  return null;
}

/** The Solid tab's targets: 1–16 distinct feature statements, all in one file. */
function validateTargetLocs(targets: unknown): SketchLoc[] | { error: string } {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COLOR_TARGETS) {
    return { error: `targets must be 1-${MAX_COLOR_TARGETS} feature statements to colour` };
  }
  const locs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (locs.length > 0 && loc.filePath !== locs[0].filePath) {
      return { error: 'the colour targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    locs.push(loc);
  }
  return locs;
}

/**
 * The colour request's shape: a CSS colour value, plus either `targets` —
 * the feature statements painted whole, by source location — or `entities`
 * (with optional `chains` and a `selectorOverride`), the faces to paint.
 */
export function validateColor(body: any): ColorRequest | { error: string } {
  const { value, targets, entities, chains, selectorOverride } = body ?? {};
  const valueError = colorValueError(value);
  if (valueError) {
    return { error: valueError };
  }
  const normalized = ColorValues.normalizeSlot(value)!;
  const hasTargets = targets !== undefined && targets !== null;
  const hasEntities = entities !== undefined && entities !== null;
  if (hasTargets === hasEntities) {
    return { error: 'a colour paints either targets (whole objects) or entities (faces) — send exactly one' };
  }
  if (hasTargets) {
    const locs = validateTargetLocs(targets);
    if ('error' in locs) {
      return locs;
    }
    return { value: normalized, paint: { kind: 'solids', targets: locs } };
  }
  const picks = validatePicks(entities);
  if (!picks) {
    return { error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
  }
  const pickChains = validateChains(chains);
  if (!pickChains) {
    return { error: 'chains must be {seed, members} pick groups' };
  }
  const overrideError = selectorOverrideError(selectorOverride);
  if (overrideError) {
    return { error: overrideError };
  }
  return {
    value: normalized,
    paint: {
      kind: 'faces',
      picks,
      chains: pickChains,
      selectorOverride: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
    },
  };
}

/**
 * The colour edit request's shape: the value (the dialog owns it outright),
 * then at most one of — a `targets` list mixing `verbatim` keeps with
 * re-picked features (the Solid tab; an empty list makes the paint
 * implicit), re-picked face `entities` flipping `needsPicks`, or an edited
 * `selectorOverride` (the Face tab). None of them keeps the statement's own
 * arguments.
 */
export function validateColorEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { value, targets, entities, chains, selectorOverride } = body ?? {};
  const valueError = colorValueError(value);
  if (valueError) {
    return { error: valueError };
  }
  const overrideError = selectorOverrideError(selectorOverride);
  if (overrideError) {
    return { error: overrideError };
  }
  const result: StatementEditRequest = {
    ...base,
    rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
  };
  edit.color = { value: ColorValues.normalizeSlot(value)! };

  const hasTargets = targets !== undefined && targets !== null;
  const hasEntities = entities !== undefined && entities !== null;
  if (hasTargets && (hasEntities || result.rawArgs !== undefined)) {
    return { error: 'a colour edit replaces its targets or its face selection, not both' };
  }
  if (hasTargets) {
    if (!Array.isArray(targets) || targets.length > MAX_COLOR_TARGETS) {
      return { error: `targets must be 0-${MAX_COLOR_TARGETS} kept or re-picked features` };
    }
    const list: NonNullable<StatementEditRequest['colorTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const raw of targets) {
      if (raw?.kind === 'verbatim') {
        if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(raw.sourceIndex);
        list.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
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
        list.push({ kind: 'feature', loc });
      } else {
        return { error: 'each target must be {kind: "verbatim"|"feature", …}' };
      }
    }
    result.colorTargets = list;
    return result;
  }
  if (hasEntities) {
    const picks = validatePicks(entities);
    if (!picks) {
      return { error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
    }
    const pickChains = validateChains(chains);
    if (!pickChains) {
      return { error: 'chains must be {seed, members} pick groups' };
    }
    result.picks = picks;
    result.chains = pickChains;
    result.needsPicks = true;
  }
  return result;
}
