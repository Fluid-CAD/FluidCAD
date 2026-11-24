// extrude(): option types and statement rendering.

import { renderRegionChain, renderScopeChain } from '../render/chains.ts';
import { formatValue, type RegionName, type RegionPickSpec, type ValueExpr } from '../value-expr.ts';
import { ValueSlots, type BooleanSlot } from '../value-slots.ts';

/**
 * The face an up-to-face extrude ends on when it is not a picked one: the
 * nearest / farthest face the extrusion runs into, which the kernel resolves
 * itself at build time.
 */
export type ExtrudeFaceTarget = 'first-face' | 'last-face';

/**
 * Which face an up-to-face extrude ends on: `selector` a picked one, rendered
 * from the statement's single selector part; the others render as their own
 * literal.
 */
export type ExtrudeTargetKind = 'selector' | ExtrudeFaceTarget;

/** The literal first argument a first/last-face target renders as. */
export function renderFaceTargetExpr(target: ExtrudeFaceTarget): string {
  return `'${target}'`;
}

/**
 * How an extrude statement is rendered and placed. A sketch profile is the
 * first producer, the profile *sketch* call: `implicit` consumes the scope's
 * last sketch (`extrude(25)`); `bound` binds the sketch to a variable
 * (`const s = …; extrude(25, s)`). A `face` profile is a picked face instead
 * — the selector part at `profilePart`, rendered as the trailing argument
 * (`extrude(25, e.endFaces())`), which the kernel sweeps as it stands. Every
 * form inserts at end of scope.
 */
export type ExtrudeEditOptions = {
  op: 'add' | 'remove' | 'new';
  /** Extrusion distance; null renders a through-all `cut()` (remove only). */
  distance: ValueExpr | null;
  /**
   * Opposite-direction distance; non-null renders the two-distance form
   * `extrude(d1, d2)`. Excludes `symmetric` and a through-all `distance`.
   */
  distance2: ValueExpr | null;
  /** `.symmetric()` — the distance is split equally across the sketch plane. */
  symmetric: boolean;
  /** `.draft(angle)` taper in degrees, or null for a straight extrude. */
  draft: ValueExpr | null;
  /**
   * `.endOffset(value)` — pulls the swept end back by that much (negative
   * pushes it past), including the face an up-to-face extrude stops on. Null
   * renders no chain.
   */
  endOffset: ValueExpr | null;
  /** False renders `.drill(false)` — inner closed regions extrude as solid; an expression renders `.drill(<expr>)`. */
  drill: BooleanSlot;
  /** `.thin(a)` / `.thin(a, b)` offsets, or null for a plain extrude. */
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profile: 'implicit' | 'bound' | 'face';
  /**
   * The selector part a `face` profile renders from. A face is swept as it
   * stands, so it excludes `thin`, `regions` and a through-all `distance`.
   */
  profilePart?: number;
  /**
   * Up-to-face mode: the target renders as the call's first argument — a
   * selector part (a picked face) for `selector`, the literal for
   * `first-face` / `last-face` — as `extrude(<target>[, s])` /
   * `cut(<target>[, s])`, in place of the distance(s). Excludes
   * `distance`/`distance2`/`symmetric`.
   */
  toFace?: ExtrudeTargetKind;
  /** The selector part a `selector` target renders from; absent reads as the first. */
  toFacePart?: number;
  /**
   * Producer indices of the `.scope(…)` targets, in pick order — the
   * solid-bearing statements the boolean fuses with or cuts from (rib's
   * contract). Absent or empty writes no chain (whole-scene fusion).
   */
  scope?: number[];
  /**
   * The `.region(…)` chain — the names of the profile regions the operation
   * builds. Absent or empty writes no chain (every region). The transform
   * derives them from `regionPicks`; a caller that already knows the names
   * (a rendered preview) passes them directly.
   */
  regions?: RegionName[];
  /**
   * The dialog's region picks. The transform declares each picked boundary
   * in the profile sketch (`region('r1', …)`, reusing a declaration that
   * already lists it) and writes the names into `regions`.
   */
  regionPicks?: RegionPickSpec[];
  /** The profile sketch statement the picks belong to — where their declarations are written. */
  regionSketch?: { line: number; column: number };
};

/**
 * Render an extrude statement from its options: `extrude(25)` / `cut()`
 * (through-all) / `extrude(10, 20)` (two distances) / `extrude(25, s)` for a
 * bound profile (`profileExpr` its variable) or a face one (`profileExpr` the
 * face's selector) / `extrude(<faceExpr>)` for an up-to-face extrude — a
 * picked face's selector or a `'first-face'` / `'last-face'` literal — plus
 * `.symmetric()` / `.draft(…)` / `.endOffset(…)` / `.drill(false)` /
 * `.thin(…)` / `.new()` chains. Shared with the route's preview so the
 * previewed text is exactly what the transform writes.
 */
export function renderExtrudeStatement(
  ext: ExtrudeEditOptions,
  profileExpr: string | null,
  faceExpr: string | null = null,
  scopeExprs: string[] = [],
): string {
  const callee = ext.op === 'remove' ? 'cut' : 'extrude';
  const callArgs: string[] = [];
  if (faceExpr !== null) {
    callArgs.push(faceExpr);
  } else if (ext.distance !== null) {
    callArgs.push(formatValue(ext.distance));
    if (ext.distance2 !== null) {
      callArgs.push(formatValue(ext.distance2));
    }
  }
  if (ext.profile === 'bound' || ext.profile === 'face') {
    callArgs.push(profileExpr ?? 's');
  }
  let statement = `${callee}(${callArgs.join(', ')})` + renderRegionChain(ext.regions);
  if (ext.symmetric) {
    statement += '.symmetric()';
  }
  if (ext.draft !== null) {
    statement += `.draft(${formatValue(ext.draft)})`;
  }
  if (ext.endOffset !== null) {
    statement += `.endOffset(${formatValue(ext.endOffset)})`;
  }
  if (ext.drill !== true) {
    // True is the API default, so only the opt-out — or an expression — is written.
    statement += `.drill(${ValueSlots.source(ext.drill, String)})`;
  }
  if (ext.thin) {
    statement += `.thin(${ext.thin.map(formatValue).join(', ')})`;
  }
  if (ext.op === 'new') {
    statement += '.new()';
  }
  return statement + renderScopeChain(scopeExprs);
}

/**
 * What a face profile cannot carry, as the kernel refuses it: the face is
 * swept as it stands, so there is nothing to offset into a thin wall, no
 * region to pick out of it, and — with one argument reading as the
 * up-to-face target — no through-all form. Null when the options fit.
 */
export function faceProfileRefusal(ext: {
  distance: ValueExpr | null;
  thin: unknown;
  toFace?: unknown;
  regionCount: number;
}): string | null {
  if (ext.thin) {
    return 'a face profile cannot be extruded thin';
  }
  if (ext.regionCount > 0) {
    return 'a face profile has no regions to pick';
  }
  if (ext.distance === null && (ext.toFace === undefined || ext.toFace === null)) {
    return 'a face profile cannot cut through all — give it a depth';
  }
  return null;
}
