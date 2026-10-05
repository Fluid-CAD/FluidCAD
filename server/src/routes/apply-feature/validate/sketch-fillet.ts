// Sketch fillet payload sanitizer.

import type { SketchFilletCorner, SketchFilletEnd } from '../../../sketch-fillet.ts';
import { sanitizeSplitPoint } from './sketch-split.ts';

/** One edge end off the wire, or null. */
function sanitizeFilletEnd(raw: unknown): SketchFilletEnd | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  if (!Number.isInteger(e.line) || (e.line as number) < 1
    || (e.featureType !== 'line' && e.featureType !== 'arc')
    || (e.role !== 'start' && e.role !== 'end')) {
    return null;
  }
  return { line: e.line as number, featureType: e.featureType, role: e.role };
}

/** The Fillet tool's corner plans off the wire — at least one — or null when any is malformed. */
export function sanitizeFilletCorners(raw: unknown): SketchFilletCorner[] | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const corners: SketchFilletCorner[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const c = entry as Record<string, unknown>;
    const a = sanitizeFilletEnd(c.a);
    const b = sanitizeFilletEnd(c.b);
    const at = sanitizeSplitPoint(c.at);
    const start = sanitizeSplitPoint(c.start);
    const end = sanitizeSplitPoint(c.end);
    const center = sanitizeSplitPoint(c.center);
    if (!a || !b || !at || !start || !end || !center || typeof c.cw !== 'boolean') {
      return null;
    }
    corners.push({ a, b, at, start, end, center, cw: c.cw });
  }
  return corners;
}
