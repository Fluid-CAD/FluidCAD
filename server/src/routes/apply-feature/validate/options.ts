// Option validators for the selector features: shell joins, offset, text and chamfer options.

import {
  validValueExpr,
  type ChamferEditOptions,
  type OffsetEditOptions,
  type ShellJoinKind,
  type TextStatementOptions,
} from '../../../apply-feature-edit/index.ts';

/** Shell's optional `.join()` type; absent means 'arc' — the kernel default. */
export function validateShellJoinType(raw: unknown): { joinType: ShellJoinKind } | { error: string } {
  if (raw === undefined || raw === null) {
    return { joinType: 'arc' };
  }
  if (raw !== 'arc' && raw !== 'intersection' && raw !== 'tangent') {
    return { error: 'joinType must be "arc", "intersection" or "tangent"' };
  }
  return { joinType: raw };
}

/**
 * The 2D offset's `.close()` toggle, riding a create or edit request: an
 * absent field reads as off, so a caller that knows nothing about it keeps
 * the plain `offset(d, …)` form.
 */
export function validateOffsetOptions(body: any): { options: OffsetEditOptions } | { error: string } {
  if (body?.removeOriginal !== undefined) {
    return { error: 'offset() no longer takes a removeOriginal flag — mark the sources .guide() instead' };
  }
  const close = body?.close ?? false;
  if (typeof close !== 'boolean') {
    return { error: 'close must be a boolean' };
  }
  return { options: { close } };
}

/**
 * The text dialog's full option payload, riding a create-on-path or edit
 * request: the string plus every chain option the dialog owns, validated
 * field by field so a refusal names the offending one.
 */
export function validateTextOptions(body: any): { options: TextStatementOptions } | { error: string } {
  const { text, size, font, weight, italic, align, lineSpacing, letterSpacing } = body ?? {};
  // The path-only options default off, so a caller that predates them keeps
  // the plain statement form.
  const offset = body?.offset ?? 0;
  const startAt = body?.startAt ?? 0;
  const flip = body?.flip ?? false;
  if (typeof text !== 'string' || text.trim() === '' || text.length > 4000) {
    return { error: 'text must be a non-empty string' };
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return { error: 'size must be a positive number' };
  }
  if (font !== null && (typeof font !== 'string' || font.length > 300)) {
    return { error: 'font must be a family name string or null' };
  }
  if (typeof weight !== 'number' || weight % 100 !== 0 || weight < 100 || weight > 900) {
    return { error: 'weight must be one of 100–900 in hundreds' };
  }
  if (typeof italic !== 'boolean') {
    return { error: 'italic must be a boolean' };
  }
  if (align !== 'left' && align !== 'center' && align !== 'right'
    && align !== 'space-between' && align !== 'space-around') {
    return { error: 'align must be "left", "center", "right", "space-between" or "space-around"' };
  }
  if (typeof lineSpacing !== 'number' || !Number.isFinite(lineSpacing) || lineSpacing <= 0) {
    return { error: 'lineSpacing must be a positive number' };
  }
  if (typeof letterSpacing !== 'number' || !Number.isFinite(letterSpacing)) {
    return { error: 'letterSpacing must be a number' };
  }
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    return { error: 'offset must be a number' };
  }
  if (typeof startAt !== 'number' || !Number.isFinite(startAt) || startAt < 0) {
    return { error: 'startAt must be a non-negative number' };
  }
  if (typeof flip !== 'boolean') {
    return { error: 'flip must be a boolean' };
  }
  return { options: { text, size, font, weight, italic, align, lineSpacing, letterSpacing, offset, startAt, flip } };
}

/**
 * The chamfer second-value slot riding a create or edit request: absent (or
 * null) reads as the equal-distance form; a value must be a positive number
 * or expression, and an angle additionally below 90° when it is a number.
 */
export function validateChamferOptions(body: any): { options: ChamferEditOptions } | { error: string } {
  const { distance2, isAngle } = body ?? {};
  if (isAngle !== undefined && typeof isAngle !== 'boolean') {
    return { error: 'isAngle must be a boolean' };
  }
  if (distance2 === undefined || distance2 === null) {
    if (isAngle === true) {
      return { error: 'isAngle requires a distance2 angle value' };
    }
    return { options: { distance2: null, isAngle: false } };
  }
  if (!validValueExpr(distance2, { positive: true })) {
    return { error: 'distance2 must be a positive number or expression' };
  }
  if (isAngle === true && typeof distance2 === 'number' && distance2 >= 90) {
    return { error: 'the chamfer angle must be below 90 degrees' };
  }
  return { options: { distance2, isAngle: isAngle === true } };
}
