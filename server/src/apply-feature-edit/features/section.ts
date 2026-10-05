// section(): the saved section view's statement — its options and rendering.

import { renderRepeatPlaneExpr, type RepeatPlaneSpec } from './repeat.ts';
import type { ApplyFeatureEditSpec } from '../spec.ts';
import { formatValue } from '../value-expr.ts';

/**
 * A `section('<name>', <plane>, { offset, flip })` statement's create
 * payload. The plane is the repeat mirror's exact input — a standard origin
 * plane, an existing plane feature bound to a variable, or a picked face's
 * selector part wrapped in `plane(…)`. The offset is a plain number: the
 * viewport arrow rewrites it on every drag.
 */
export type SectionEditOptions = {
  /** The view's name, as the section menu lists it. */
  name: string;
  plane: RepeatPlaneSpec;
  /** Distance along the plane normal; 0 renders no option. */
  offset: number;
  /** Keep the normal's half instead of removing it; false renders no option. */
  flip: boolean;
};

/** The options-object argument: `{ offset: 5, flip: true }`, or nothing when both are defaults. */
export function renderSectionOptionsArg(offset: number, flip: boolean): string {
  const entries: string[] = [];
  if (offset !== 0) {
    entries.push(`offset: ${formatValue(offset)}`);
  }
  if (flip) {
    entries.push('flip: true');
  }
  return entries.length > 0 ? `, { ${entries.join(', ')} }` : '';
}

/**
 * Render the statement from its rendered plane expression:
 * `section('A-A', 'xz')` / `section('Bore', p, { offset: 12 })` /
 * `section('Top', plane(e.endFaces()), { flip: true })`. Shared with the
 * route's preview so the previewed text is exactly what the transform writes.
 */
export function renderSectionStatement(so: SectionEditOptions, planeExpr: string): string {
  const name = so.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `section('${name}', ${planeExpr}${renderSectionOptionsArg(so.offset, so.flip)})`;
}

export function renderSectionPlaneExpr(
  so: SectionEditOptions,
  parts: ApplyFeatureEditSpec['parts'],
  varFor: (producer: number) => string | null,
): string {
  return renderRepeatPlaneExpr(so.plane, parts, varFor);
}

export function validSectionOptions(so: unknown): so is SectionEditOptions {
  const s = so as SectionEditOptions | undefined;
  return s !== undefined && s !== null
    && typeof s.name === 'string' && s.name.trim() !== ''
    && typeof s.offset === 'number' && Number.isFinite(s.offset)
    && typeof s.flip === 'boolean';
}
