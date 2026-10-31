// Option validators for the selector features: shell joins, offset, text and chamfer options.

import {
  TEXT_ALIGNMENTS,
  TEXT_FONT_LIMIT,
  TEXT_LITERAL_LIMIT,
  TEXT_WEIGHTS,
  validValueExpr,
  ValueSlots,
  type ChamferEditOptions,
  type OffsetEditOptions,
  SHELL_JOIN_KINDS,
  type ShellJoinSlot,
  type TextStatementOptions,
} from '../../../apply-feature-edit/index.ts';

/**
 * Shell's optional `.join()` type — a kind, or an expression computing one;
 * absent means 'arc' — the kernel default. Whether an expression's text may
 * be written is the transform's to say.
 */
export function validateShellJoinType(raw: unknown): { joinType: ShellJoinSlot } | { error: string } {
  if (raw === undefined || raw === null) {
    return { joinType: 'arc' };
  }
  if (!ValueSlots.shaped(raw, literal => (SHELL_JOIN_KINDS as readonly unknown[]).includes(literal))) {
    return { error: 'joinType must be "arc", "intersection" or "tangent", or an expression' };
  }
  return { joinType: raw as ShellJoinSlot };
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
 * field by field so a refusal names the offending one. Each slot is checked
 * for shape only — a literal within its row's range, or an expression
 * holding text ({@link ValueSlots.shaped}); whether an expression may be
 * written is the transform's to say, with the statement's own kept.
 */
export function validateTextOptions(body: any): { options: TextStatementOptions } | { error: string } {
  const { text, size, font, weight, italic, align, lineSpacing, letterSpacing } = body ?? {};
  // The path-only options default off, so a caller that predates them keeps
  // the plain statement form.
  const offset = body?.offset ?? 0;
  const startAt = body?.startAt ?? 0;
  const flip = body?.flip ?? false;
  const offered = (options: readonly (string | number)[]) => (literal: unknown) =>
    (typeof literal === 'string' || typeof literal === 'number') && options.includes(literal);
  if (!ValueSlots.shaped(text, literal => typeof literal === 'string' && literal.trim() !== '' && literal.length <= TEXT_LITERAL_LIMIT)) {
    return { error: 'text must be a non-empty string or an expression' };
  }
  if (!validValueExpr(size, { positive: true })) {
    return { error: 'size must be a positive number or expression' };
  }
  if (font !== null && !ValueSlots.shaped(font, literal => typeof literal === 'string' && literal.length <= TEXT_FONT_LIMIT)) {
    return { error: 'font must be a family name string, an expression or null' };
  }
  if (!ValueSlots.shaped(weight, offered(TEXT_WEIGHTS))) {
    return { error: 'weight must be one of 100–900 in hundreds, or an expression' };
  }
  if (!ValueSlots.shaped(italic, literal => typeof literal === 'boolean')) {
    return { error: 'italic must be a boolean or an expression' };
  }
  if (!ValueSlots.shaped(align, offered(TEXT_ALIGNMENTS))) {
    return { error: 'align must be "left", "center", "right", "space-between" or "space-around", or an expression' };
  }
  if (!validValueExpr(lineSpacing, { positive: true })) {
    return { error: 'lineSpacing must be a positive number or expression' };
  }
  if (!validValueExpr(letterSpacing)) {
    return { error: 'letterSpacing must be a number or expression' };
  }
  if (!validValueExpr(offset)) {
    return { error: 'offset must be a number or expression' };
  }
  if (!validValueExpr(startAt) || (typeof startAt === 'number' && startAt < 0)) {
    return { error: 'startAt must be a non-negative number or expression' };
  }
  if (!ValueSlots.shaped(flip, literal => typeof literal === 'boolean')) {
    return { error: 'flip must be a boolean or an expression' };
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
