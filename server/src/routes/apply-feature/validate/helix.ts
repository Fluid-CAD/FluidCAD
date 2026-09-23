// helix request validation.

import { validValueExpr, type ValueExpr } from '../../../apply-feature-edit/index.ts';
import { validatePick, type Pick } from '../picks.ts';
import { validateRevolveAxis, type RevolveAxisInput } from './revolve.ts';

/**
 * One helix source input: the revolve axis family (a standard world axis, an
 * existing axis statement, or a picked edge → `axis(<selector>)`) plus a picked
 * cylindrical/conical face — the single selector on its own.
 */
export type HelixSourceInput = RevolveAxisInput | { kind: 'face'; pick: Pick };

/**
 * The helix request: a single source (axis-family or face) and the chained
 * geometry configurators — each optional, null when the dialog left it blank
 * so the helix() API default applies. A helix is a wire, so there is no op,
 * profile, or thin mode.
 */
type HelixRequest = {
  source: HelixSourceInput;
  radius: ValueExpr | null;
  endRadius: ValueExpr | null;
  pitch: ValueExpr | null;
  turns: ValueExpr | null;
  height: ValueExpr | null;
  startOffset: ValueExpr | null;
  endOffset: ValueExpr | null;
};

/** The helix source: the revolve axis inputs plus a picked face. */
export function validateHelixSource(raw: any): HelixSourceInput | { error: string } {
  if (raw?.kind === 'face') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'face') {
      return { error: 'a helix face must carry a {shapeId, sub:{type:"face", index}} pick' };
    }
    return { kind: 'face', pick };
  }
  return validateRevolveAxis(raw);
}

/** An optional helix option: omitted (null/undefined) or a constrained value. */
export function validateHelixOption(
  value: unknown,
  label: string,
  opts: { positive?: boolean; nonzero?: boolean } = {},
): { value: ValueExpr | null } | { error: string } {
  if (value === null || value === undefined) {
    return { value: null };
  }
  if (!validValueExpr(value, opts)) {
    const kind = opts.positive ? 'positive ' : opts.nonzero ? 'nonzero ' : '';
    return { error: `${label} must be a ${kind}number or expression` };
  }
  return { value };
}

export function validateHelix(body: any): HelixRequest | { error: string } {
  const source = validateHelixSource(body?.source);
  if ('error' in source) {
    return source;
  }
  const radius = validateHelixOption(body?.radius, 'radius', { positive: true });
  if ('error' in radius) {
    return radius;
  }
  const endRadius = validateHelixOption(body?.endRadius, 'endRadius', { positive: true });
  if ('error' in endRadius) {
    return endRadius;
  }
  const pitch = validateHelixOption(body?.pitch, 'pitch', { nonzero: true });
  if ('error' in pitch) {
    return pitch;
  }
  const turns = validateHelixOption(body?.turns, 'turns', { positive: true });
  if ('error' in turns) {
    return turns;
  }
  const height = validateHelixOption(body?.height, 'height', { positive: true });
  if ('error' in height) {
    return height;
  }
  const startOffset = validateHelixOption(body?.startOffset, 'startOffset');
  if ('error' in startOffset) {
    return startOffset;
  }
  const endOffset = validateHelixOption(body?.endOffset, 'endOffset');
  if ('error' in endOffset) {
    return endOffset;
  }
  return {
    source,
    radius: radius.value,
    endRadius: endRadius.value,
    pitch: pitch.value,
    turns: turns.value,
    height: height.value,
    startOffset: startOffset.value,
    endOffset: endOffset.value,
  };
}
