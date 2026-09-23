// Parsing the repeat, copy, mirror and rotate ghost requests (3D and in-sketch).

import type { GhostAxisRef, GhostPlaneRef, GhostSketchAxisRef } from '../../fluidcad-server.ts';
import {
  MAX_COPY_TARGETS,
  MAX_MIRROR_TARGETS,
  MAX_REPEAT_TARGETS,
  MAX_ROTATE_TARGETS,
} from '../apply-feature/index.ts';
import {
  parseAxes,
  parseAxis,
  parsePlane,
  parseSketchAxes,
  parseSketchEntityRefs,
  parseSourceRefs,
} from './refs.ts';
import { isValueExpr, isValueExprOrNull, type ValueExpr } from './values.ts';
import {
  COPY_KINDS,
  MAX_GHOST_DIRECTIONS,
  MAX_GHOST_SKIP,
  REPEAT_KINDS,
  SWEEP_MODES,
  type GhostBody,
} from './vocabulary.ts';

/** One linear direction before its numbers are resolved. */
type RawDirection = { count: ValueExpr; offset: ValueExpr | null; length: ValueExpr | null };

/**
 * The linear directions, each carrying its own count and spacing. Exactly one
 * spacing form per direction: the distance between neighbours, or the span
 * they share — the dialog's Offset/Total mode picks which, and a direction
 * stating both (or neither) is malformed.
 */
function parseDirections(value: unknown): RawDirection[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const directions: RawDirection[] = [];
  for (const raw of value) {
    const entry = raw as { count?: unknown; offset?: unknown; length?: unknown };
    if (!entry || !isValueExpr(entry.count)
      || !isValueExprOrNull(entry.offset) || !isValueExprOrNull(entry.length)) {
      return null;
    }
    const offset = isValueExpr(entry.offset) ? entry.offset : null;
    const length = isValueExpr(entry.length) ? entry.length : null;
    if ((offset === null) === (length === null)) {
      return null;
    }
    directions.push({ count: entry.count, offset, length });
  }
  return directions;
}

/** The circular dialog's angle field, before its value is resolved. */
type RawSweep = { mode: 'angle' | 'offset'; value: ValueExpr };

function parseSweep(value: unknown): RawSweep | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const sweep = value as { mode?: unknown; value?: unknown };
  return typeof sweep.mode === 'string' && SWEEP_MODES.includes(sweep.mode)
    && isValueExpr(sweep.value)
    ? { mode: sweep.mode as RawSweep['mode'], value: sweep.value }
    : null;
}

/** A repeat request's slots, before its numbers are resolved. */
export type RawRepeat = {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  targets: { filePath: string; line: number }[];
  axes: GhostAxisRef[];
  plane: GhostPlaneRef | null;
  directions: RawDirection[];
  centered: boolean;
  count: ValueExpr | null;
  sweep: RawSweep | null;
  angle: ValueExpr | null;
};

/**
 * The repeat dialog's slots, cross-checked kind by kind: a linear repeat needs
 * an axis per direction, a circular one a count and an angle, a rotate its
 * angle, a mirror its plane.
 *
 * Hand-written rather than shared with apply-feature's `validateRepeat` on
 * purpose: that one validates a statement about to be written, this one a
 * dialog mid-composition, and the two have different shapes and different
 * nullability. They must not drift into each other.
 */
export function parseRepeat(body: GhostBody): RawRepeat | string {
  if (typeof body.kind !== 'string' || !REPEAT_KINDS.includes(body.kind)) {
    return 'Invalid repeat kind';
  }
  const kind = body.kind as RawRepeat['kind'];
  const targets = parseSourceRefs(body.targets);
  if (!targets || targets.length === 0 || targets.length > MAX_REPEAT_TARGETS) {
    return 'Invalid repeat targets';
  }
  const axes = parseAxes(body.axes ?? []);
  if (!axes) {
    return 'Invalid axis reference';
  }
  const directions = parseDirections(body.directions ?? []);
  if (!directions || directions.length > MAX_GHOST_DIRECTIONS) {
    return 'Invalid repeat directions';
  }
  const plane = body.plane == null ? null : parsePlane(body.plane);
  const sweep = body.sweep == null ? null : parseSweep(body.sweep);
  if ((body.plane != null && !plane) || (body.sweep != null && !sweep)) {
    return 'Invalid repeat source';
  }

  if (kind === 'linear') {
    // One axis per direction — the pairing IS the request; a mismatch would
    // silently repeat along the wrong one.
    if (directions.length === 0 || axes.length !== directions.length) {
      return 'Invalid repeat directions';
    }
  } else if (kind === 'mirror') {
    if (!plane) {
      return 'Invalid mirror plane';
    }
  } else {
    if (axes.length !== 1) {
      return 'Invalid axis reference';
    }
    if (kind === 'circular' && (!isValueExpr(body.count) || !sweep)) {
      return 'Invalid circular repeat';
    }
    if (kind === 'rotate' && !isValueExpr(body.angle)) {
      return 'Invalid rotation angle';
    }
  }

  return {
    kind,
    targets,
    axes,
    plane,
    directions,
    centered: body.centered === true,
    count: isValueExpr(body.count) ? body.count : null,
    sweep,
    angle: isValueExpr(body.angle) ? body.angle : null,
  };
}

/** A copy request's slots, before its numbers are resolved. */
export type RawCopy = {
  kind: 'linear' | 'circular';
  targets: { filePath: string; line: number }[];
  axes: GhostAxisRef[];
  directions: RawDirection[];
  centered: boolean;
  count: ValueExpr | null;
  sweep: RawSweep | null;
  /** Already numbers — a skip list names literal positions, never expressions. */
  skip: number[][];
};

/**
 * The copy dialog's slots, cross-checked kind by kind: a linear copy needs an
 * axis per direction, a circular one a single axis with a count and an angle.
 * It carries no plane and no rotate angle — a copy walks or spins, and mirrors
 * nothing.
 *
 * Hand-written rather than shared with {@link parseRepeat}, for the reason
 * that one isn't shared with apply-feature's `validateCopy`: near-identical
 * shapes validated for different purposes must not drift into each other.
 */
export function parseCopy(body: GhostBody): RawCopy | string {
  if (typeof body.kind !== 'string' || !COPY_KINDS.includes(body.kind)) {
    return 'Invalid copy kind';
  }
  const kind = body.kind as RawCopy['kind'];
  const targets = parseSourceRefs(body.targets);
  if (!targets || targets.length === 0 || targets.length > MAX_COPY_TARGETS) {
    return 'Invalid copy targets';
  }
  const axes = parseAxes(body.axes ?? []);
  if (!axes) {
    return 'Invalid axis reference';
  }
  const directions = parseDirections(body.directions ?? []);
  if (!directions || directions.length > MAX_GHOST_DIRECTIONS) {
    return 'Invalid copy directions';
  }
  const sweep = body.sweep == null ? null : parseSweep(body.sweep);
  if (body.sweep != null && !sweep) {
    return 'Invalid copy sweep';
  }
  const skip = parseSkip(body.skip, kind === 'linear' ? Math.max(1, directions.length) : 1);
  if (!skip) {
    return 'Invalid copy skip';
  }

  if (kind === 'linear') {
    // One axis per direction — the pairing IS the request; a mismatch would
    // silently copy along the wrong one.
    if (directions.length === 0 || axes.length !== directions.length) {
      return 'Invalid copy directions';
    }
  } else {
    if (axes.length !== 1) {
      return 'Invalid axis reference';
    }
    if (!isValueExpr(body.count) || !sweep) {
      return 'Invalid circular copy';
    }
  }

  return {
    kind,
    targets,
    axes,
    directions,
    centered: body.centered === true,
    count: isValueExpr(body.count) ? body.count : null,
    sweep,
    skip,
  };
}

/** A mirror request's slots — a plane and targets, nothing to resolve. */
export type RawMirror = {
  targets: { filePath: string; line: number }[];
  plane: GhostPlaneRef;
};

/**
 * The mirror dialog's slots: target statements and the plane to reflect them
 * across. It carries no axis, no count and no numbers at all — the op is the
 * only other field, and the general op check already validated it.
 */
export function parseMirror(body: GhostBody): RawMirror | string {
  const targets = parseSourceRefs(body.targets);
  if (!targets || targets.length === 0 || targets.length > MAX_MIRROR_TARGETS) {
    return 'Invalid mirror targets';
  }
  const plane = parsePlane(body.plane);
  if (!plane) {
    return 'Invalid mirror plane';
  }
  return { targets, plane };
}

/** A rotate request's slots, before its angle is resolved. */
export type RawRotate = {
  targets: { filePath: string; line: number }[];
  axis: GhostAxisRef;
};

/**
 * The rotate dialog's slots: target statements, the axis to turn them around
 * and the angle — the mirror's shape with an axis where the plane was. The
 * copy flag never travels: either way the stamp is where the bodies land.
 */
export function parseRotate(body: GhostBody): RawRotate | string {
  const targets = parseSourceRefs(body.targets);
  if (!targets || targets.length === 0 || targets.length > MAX_ROTATE_TARGETS) {
    return 'Invalid rotate targets';
  }
  const axis = parseAxis(body.axis);
  if (!axis) {
    return 'Invalid axis reference';
  }
  if (!isValueExpr(body.angle)) {
    return 'Invalid rotation angle';
  }
  return { targets, axis };
}

/** A 2D copy request's slots, before its numbers are resolved. */
export type RawCopy2D = {
  kind: 'linear' | 'circular';
  entities: { shapeId: string }[];
  axes: GhostSketchAxisRef[];
  directions: RawDirection[];
  centered: boolean;
  center: [ValueExpr, ValueExpr] | null;
  count: ValueExpr | null;
  sweep: RawSweep | null;
  skip: number[][];
};

/**
 * The in-sketch copy dialog's slots, cross-checked kind by kind: a linear
 * copy needs a sketch axis per direction, a circular one a center point with
 * a count and an angle. The targets are sketch-edge picks, and an empty list
 * is valid — the target-less (whole sketch) statement form only the edit
 * dialog produces. Hand-written rather than shared with {@link parseCopy} for
 * the same reason that one isn't shared with {@link parseRepeat}:
 * near-identical shapes validated for different purposes must not drift into
 * each other.
 */
export function parseCopy2D(body: GhostBody): RawCopy2D | string {
  if (typeof body.kind !== 'string' || !COPY_KINDS.includes(body.kind)) {
    return 'Invalid copy kind';
  }
  const kind = body.kind as RawCopy2D['kind'];
  const entities = parseSketchEntityRefs(body.entities);
  if (!entities) {
    return 'Invalid copy targets';
  }
  const axes = parseSketchAxes(body.axes ?? []);
  if (!axes) {
    return 'Invalid axis reference';
  }
  const directions = parseDirections(body.directions ?? []);
  if (!directions || directions.length > MAX_GHOST_DIRECTIONS) {
    return 'Invalid copy directions';
  }
  const sweep = body.sweep == null ? null : parseSweep(body.sweep);
  if (body.sweep != null && !sweep) {
    return 'Invalid copy sweep';
  }
  const skip = parseSkip(body.skip, kind === 'linear' ? Math.max(1, directions.length) : 1);
  if (!skip) {
    return 'Invalid copy skip';
  }

  let center: [ValueExpr, ValueExpr] | null = null;
  if (kind === 'linear') {
    // One axis per direction — the pairing IS the request; a mismatch would
    // silently copy along the wrong one.
    if (directions.length === 0 || axes.length !== directions.length) {
      return 'Invalid copy directions';
    }
  } else {
    // A circular in-sketch copy spins about a center point, never an axis.
    if (axes.length !== 0) {
      return 'Invalid axis reference';
    }
    if (!Array.isArray(body.center) || body.center.length !== 2
      || !isValueExpr(body.center[0]) || !isValueExpr(body.center[1])) {
      return 'Invalid copy center';
    }
    center = [body.center[0], body.center[1]];
    if (!isValueExpr(body.count) || !sweep) {
      return 'Invalid circular copy';
    }
  }

  return {
    kind,
    entities,
    axes,
    directions,
    centered: body.centered === true,
    center,
    count: isValueExpr(body.count) ? body.count : null,
    sweep,
    skip,
  };
}

/** A 2D mirror request's slots: the targets and the line to reflect across. */
export type RawMirror2D = {
  entities: { shapeId: string }[];
  axis: GhostSketchAxisRef;
};

/**
 * The in-sketch mirror dialog's slots: sketch-edge targets (an empty list is
 * the whole-sketch form) and exactly one axis — a sketch-plane datum or a
 * picked line, the 2D copy's direction slot shape. Hand-written rather than
 * shared with {@link parseCopy2D}, which validates a different purpose.
 */
export function parseMirror2D(body: GhostBody): RawMirror2D | string {
  const entities = parseSketchEntityRefs(body.entities);
  if (!entities) {
    return 'Invalid mirror targets';
  }
  const axes = parseSketchAxes(body.axis === undefined ? [] : [body.axis]);
  if (!axes || axes.length !== 1) {
    return 'Invalid axis reference';
  }
  return { entities, axis: axes[0] };
}

/**
 * A copy's skip list: index tuples, one index per direction at most. Plain
 * whole numbers only — a skip names literal positions, so nothing here goes
 * through {@link resolveExpr}. Null on anything malformed; absent is the empty
 * list, which skips nothing.
 */
function parseSkip(value: unknown, arity: number): number[][] | null {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_GHOST_SKIP) {
    return null;
  }
  const entries: number[][] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > arity) {
      return null;
    }
    if (!raw.every(index => Number.isSafeInteger(index) && index >= 0)) {
      return null;
    }
    entries.push(raw as number[]);
  }
  return entries;
}
