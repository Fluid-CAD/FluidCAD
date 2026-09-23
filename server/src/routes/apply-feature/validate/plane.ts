// plane request validation (create and edit).

import {
  validPlaneRotationAxes,
  validValueExpr,
  type FeatureStatementEditTarget,
  type PlaneRotationAxes,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick } from '../picks.ts';
import type { StatementEditRequest } from './statement-edit.ts';

/** One base of a plane request: a standard plane, a viewport pick, or an existing plane feature. */
type PlaneBaseInput =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'pick'; pick: Pick }
  | { kind: 'plane'; loc: SketchLoc }
  /** A helix statement as the edge form's base (its wire is the edge). */
  | { kind: 'wire'; loc: SketchLoc };

/** One base of an edited plane: keep the statement's own text, or re-source it. */
export type PlaneEditBaseInput = { kind: 'verbatim'; sourceIndex: number } | PlaneBaseInput;

type PlaneValues = {
  type: 'offset' | 'mid' | 'edge';
  offset: ValueExpr | null;
  rotateX: ValueExpr | null;
  rotateY: ValueExpr | null;
  rotateZ: ValueExpr | null;
  rotationAxes: PlaneRotationAxes;
  position: ValueExpr | null;
};

type PlaneRequest = PlaneValues & {
  bases: PlaneBaseInput[];
};

/**
 * The value half of a plane request, shared by the create and edit paths: the
 * form plus its numeric options. The offset, the per-axis rotations and the
 * axes they turn around (`local` when absent) are optional and belong to the
 * offset/mid forms — the edge form's second argument slot is taken by its
 * normalized 0–1 position.
 */
function validatePlaneValues(body: any): PlaneValues | { error: string } {
  const { type } = body ?? {};
  if (type !== 'offset' && type !== 'mid' && type !== 'edge') {
    return { error: 'type must be "offset", "mid" or "edge"' };
  }
  const axes: PlaneRotationAxes = body?.rotationAxes ?? 'local';
  if (!validPlaneRotationAxes(axes)) {
    return { error: 'rotationAxes must be "local" or "world"' };
  }
  const numbers: Record<string, ValueExpr | null> = {};
  for (const key of ['offset', 'rotateX', 'rotateY', 'rotateZ', 'position'] as const) {
    const raw = body?.[key];
    if (raw === undefined || raw === null) {
      numbers[key] = null;
      continue;
    }
    if (!validValueExpr(raw)) {
      return { error: `${key} must be a finite number or expression` };
    }
    numbers[key] = raw;
  }
  if (type === 'edge') {
    if (numbers.position === null
      || (typeof numbers.position === 'number' && (numbers.position < 0 || numbers.position > 1))) {
      return { error: 'position must be a number between 0 (start) and 1 (end), or an expression' };
    }
    if (numbers.offset !== null || numbers.rotateX !== null || numbers.rotateY !== null || numbers.rotateZ !== null
      || axes === 'world') {
      return { error: 'an edge plane takes a position only — no offset or rotation' };
    }
  } else if (numbers.position !== null) {
    return { error: 'position is only valid for an edge plane' };
  }
  return {
    type,
    offset: numbers.offset,
    rotateX: numbers.rotateX,
    rotateY: numbers.rotateY,
    rotateZ: numbers.rotateZ,
    rotationAxes: axes,
    position: numbers.position,
  };
}

/**
 * One base of a plane: a standard origin plane, a picked face/edge, an
 * existing plane feature addressed by its source location, or — for the edge
 * form — a single-curve sketch or a helix, whose wire is the edge.
 */
function validatePlaneBase(raw: any, type: PlaneValues['type']): PlaneBaseInput | { error: string } {
  if (raw?.kind === 'standard') {
    if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
      return { error: 'a standard base must be "xy", "xz" or "yz"' };
    }
    return { kind: 'standard', plane: raw.plane };
  }
  if (raw?.kind === 'pick') {
    const pick = validatePick(raw.entity);
    if (!pick) {
      return { error: 'a picked base must carry a {shapeId, sub:{type, index}} pick' };
    }
    return { kind: 'pick', pick };
  }
  if (raw?.kind === 'plane') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a plane base must carry the plane {filePath, line}' };
    }
    return { kind: 'plane', loc };
  }
  if (raw?.kind === 'wire') {
    if (type !== 'edge') {
      return { error: 'a sketch or helix base is only valid for an edge plane' };
    }
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a wire base must carry its statement {filePath, line}' };
    }
    return { kind: 'wire', loc };
  }
  return { error: 'each base must be {kind: "standard"|"pick"|"plane"|"wire", …}' };
}

/** One base of an edited plane: keep by position, or any create-mode base. */
function validatePlaneEditBase(raw: any, type: PlaneValues['type']): PlaneEditBaseInput | { error: string } {
  if (raw?.kind === 'verbatim') {
    if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0) {
      return { error: 'a kept base must carry its {sourceIndex} in the statement' };
    }
    return { kind: 'verbatim', sourceIndex: raw.sourceIndex };
  }
  return validatePlaneBase(raw, type);
}

/** A base's identity, for the duplicate check. */
function planeBaseKey(base: PlaneEditBaseInput): string {
  switch (base.kind) {
    case 'verbatim': return `verbatim:${base.sourceIndex}`;
    case 'standard': return `standard:${base.plane}`;
    case 'pick': return `pick:${base.pick.shapeId}:${base.pick.sub.type}:${base.pick.sub.index}`;
    default: return `${base.kind}:${base.loc.filePath}:${base.loc.line}`;
  }
}

/**
 * A plane's base list: one base for an offset or edge plane, two for a mid
 * plane. Duplicates are rejected — a mid plane between a base and itself is
 * degenerate — and the edge form's base must be an edge source.
 */
function validatePlaneBaseList<T extends PlaneEditBaseInput>(
  bases: any,
  type: PlaneValues['type'],
  validateBase: (raw: any) => T | { error: string },
): T[] | { error: string } {
  const expected = type === 'mid' ? 2 : 1;
  if (!Array.isArray(bases) || bases.length !== expected) {
    return {
      error: type === 'mid'
        ? 'a mid plane takes exactly two bases'
        : `an ${type} plane takes exactly one base`,
    };
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (const raw of bases) {
    const base = validateBase(raw);
    if ('error' in base) {
      return base;
    }
    const key = planeBaseKey(base);
    if (seen.has(key)) {
      return { error: 'the two bases must be different' };
    }
    seen.add(key);
    result.push(base);
  }
  const source = result[0];
  // The edge form's base is an edge source — a picked edge, or a sketch/helix
  // statement drawing one curve. A kept base is checked against the parsed
  // statement by the transform, the only place its expression is known.
  if (type === 'edge' && source.kind !== 'wire' && source.kind !== 'verbatim'
    && (source.kind !== 'pick' || source.pick.sub.type !== 'edge')) {
    return { error: 'an edge plane takes a single picked edge, sketch curve or helix as its base' };
  }
  return result;
}

/** The create request's shape: the plane's values plus its bases. */
export function validatePlane(body: any): PlaneRequest | { error: string } {
  const values = validatePlaneValues(body);
  if ('error' in values) {
    return values;
  }
  const bases = validatePlaneBaseList<PlaneBaseInput>(
    body?.bases, values.type, raw => validatePlaneBase(raw, values.type),
  );
  if ('error' in bases) {
    return bases;
  }
  return { ...values, bases };
}

/**
 * The plane edit request's shape: the form and its numeric options (the
 * dialog owns all of them, so they always ride), plus the optional base list
 * mixing `verbatim` keeps with re-sourced bases; an absent list keeps every
 * statement base. A picked base flips `needsPicks` — its selector is
 * synthesized against the pre-statement boundary.
 */
export function validatePlaneEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const values = validatePlaneValues(body);
  if ('error' in values) {
    return values;
  }
  edit.plane = values;
  const result: StatementEditRequest = base;
  if (body?.bases === undefined || body?.bases === null) {
    return result;
  }
  const bases = validatePlaneBaseList<PlaneEditBaseInput>(
    body.bases, values.type, raw => validatePlaneEditBase(raw, values.type),
  );
  if ('error' in bases) {
    return bases;
  }
  result.planeBases = bases;
  result.needsPicks = bases.some(b => b.kind === 'pick');
  return result;
}
