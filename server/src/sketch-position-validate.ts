// Off-the-wire validation of a solved-sketch position write-back (P4): the
// drag's own batch, and the `settle` a cut tool (Split, Trim) runs ahead of
// its edit so the source it cuts is already at rest.

import type { SketchPositionEdit } from './code-editor.ts';

/** A [x, y] pair of finite numbers, or null for anything else. */
export function validPoint(input: unknown): [number, number] | null {
  if (Array.isArray(input) && input.length === 2
    && typeof input[0] === 'number' && Number.isFinite(input[0])
    && typeof input[1] === 'number' && Number.isFinite(input[1])) {
    return [input[0], input[1]];
  }
  return null;
}

/** A `{ value, expected? }` scalar change of finite numbers, or null. */
function validScalar(input: unknown): { value: number; expected?: number } | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const s = input as Record<string, unknown>;
  if (typeof s.value !== 'number' || !Number.isFinite(s.value)
    || (s.expected !== undefined && (typeof s.expected !== 'number' || !Number.isFinite(s.expected)))) {
    return null;
  }
  return { value: s.value, ...(s.expected !== undefined ? { expected: s.expected as number } : {}) };
}

/** One statement's worth of a position write-back, or null when malformed. */
export function validateSketchPositionEdit(input: unknown): SketchPositionEdit | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.sourceLine !== 'number' || !Number.isInteger(obj.sourceLine) || obj.sourceLine < 1) {
    return null;
  }
  const edit: SketchPositionEdit = { sourceLine: obj.sourceLine };
  if (obj.points !== undefined) {
    if (!Array.isArray(obj.points)) {
      return null;
    }
    const points: NonNullable<SketchPositionEdit['points']> = [];
    for (const raw of obj.points) {
      const p = (typeof raw === 'object' && raw !== null ? raw : null) as Record<string, unknown> | null;
      const position = validPoint(p?.position);
      if (!p || typeof p.pointIndex !== 'number' || !Number.isInteger(p.pointIndex) || position === null
        || (p.expected !== undefined && validPoint(p.expected) === null)) {
        return null;
      }
      points.push({
        pointIndex: p.pointIndex,
        position,
        ...(p.expected !== undefined ? { expected: validPoint(p.expected)! } : {}),
      });
    }
    edit.points = points;
  }
  if (obj.scalar !== undefined) {
    const scalar = validScalar(obj.scalar);
    if (!scalar) {
      return null;
    }
    edit.scalar = scalar;
  }
  if (obj.radii !== undefined) {
    if (typeof obj.radii !== 'object' || obj.radii === null) {
      return null;
    }
    const r = obj.radii as Record<string, unknown>;
    const radii: NonNullable<SketchPositionEdit['radii']> = {};
    for (const key of ['rx', 'ry'] as const) {
      if (r[key] !== undefined) {
        const change = validScalar(r[key]);
        if (!change) {
          return null;
        }
        radii[key] = change;
      }
    }
    edit.radii = radii;
  }
  if (obj.rotation !== undefined) {
    const rotation = validScalar(obj.rotation);
    if (!rotation) {
      return null;
    }
    edit.rotation = rotation;
  }
  return edit;
}

/**
 * A whole batch off the wire: absent → no edits; anything but an array of
 * valid edits → null.
 */
export function validateSketchPositionEdits(input: unknown): SketchPositionEdit[] | null {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    return null;
  }
  const edits: SketchPositionEdit[] = [];
  for (const raw of input) {
    const edit = validateSketchPositionEdit(raw);
    if (!edit) {
      return null;
    }
    edits.push(edit);
  }
  return edits;
}
