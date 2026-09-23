// Sketch split/trim payload sanitizers.

import { sanitizeEmissionTarget } from '../../../sketch-solved-edit.ts';
import {
  SketchEntitySplit,
  type SplitPiece,
  type SplitPoint,
  type SplittableEntity,
} from '../../../../../lib/dist/features/2d/split.js';

/** A finite `[x, y]` pair off the wire, or null. */
export function sanitizeSplitPoint(raw: unknown): SplitPoint | null {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every(v => typeof v === 'number' && Number.isFinite(v))) {
    return null;
  }
  return [raw[0], raw[1]];
}

/** The Split tool's entity geometry off the wire, or null. */
export function sanitizeSplittableEntity(raw: unknown): SplittableEntity | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  switch (e.kind) {
    case 'line': {
      const start = sanitizeSplitPoint(e.start);
      const end = sanitizeSplitPoint(e.end);
      return start && end ? { kind: 'line', start, end } : null;
    }
    case 'arc': {
      const start = sanitizeSplitPoint(e.start);
      const end = sanitizeSplitPoint(e.end);
      const center = sanitizeSplitPoint(e.center);
      return start && end && center && typeof e.cw === 'boolean'
        ? { kind: 'arc', start, end, center, cw: e.cw }
        : null;
    }
    case 'circle': {
      const center = sanitizeSplitPoint(e.center);
      return center && typeof e.radius === 'number' && Number.isFinite(e.radius) && e.radius > 0
        ? { kind: 'circle', center, radius: e.radius }
        : null;
    }
    default:
      return null;
  }
}

/**
 * The Split/Trim tools' constraint hints off the wire — where each
 * whole-entity constraint touches the entity, by statement line — or null
 * when any is malformed.
 */
export function sanitizeCutHints(raw: unknown): { line: number; locus: SplitPoint }[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const hints: { line: number; locus: SplitPoint }[] = [];
  for (const h of raw) {
    const locus = sanitizeSplitPoint(h?.locus);
    if (typeof h !== 'object' || h === null || !Number.isInteger(h.line) || h.line < 1 || locus === null) {
      return null;
    }
    hints.push({ line: h.line, locus });
  }
  return hints;
}

/** The hints resolved to the piece each touches — the transforms' `assignments`. */
export function assignHints(pieces: SplitPiece[], hints: { line: number; locus: SplitPoint }[]): { line: number; piece: number }[] {
  return hints.map(h => ({ line: h.line, piece: SketchEntitySplit.nearestPiece(pieces, h.locus) }));
}

type CutterTarget = NonNullable<ReturnType<typeof sanitizeEmissionTarget>>;

/**
 * The Trim tool's cutting edges off the wire — one emission target (or
 * null) per cut — or null when malformed or not one per cut.
 */
export function sanitizeCutters(raw: unknown, cutCount: number): (CutterTarget | null)[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length !== cutCount) {
    return null;
  }
  const cutters: (CutterTarget | null)[] = [];
  for (const t of raw) {
    if (t === null) {
      cutters.push(null);
      continue;
    }
    const cleaned = sanitizeEmissionTarget(t, { allowNew: false });
    if (cleaned === null) {
      return null;
    }
    cutters.push(cleaned);
  }
  return cutters;
}
