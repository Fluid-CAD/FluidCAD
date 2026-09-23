// Parsing the geometry references a ghost request carries: axes, paths, sections, entities, planes.

import type {
  GhostAxisRef,
  GhostEntityRef,
  GhostHelixSourceRef,
  GhostPathRef,
  GhostPlaneBaseRef,
  GhostPlaneRef,
  GhostSectionRef,
  GhostSketchAxisRef,
} from '../../fluidcad-server.ts';
import { STANDARD_AXES, STANDARD_PLANES, type GhostBody } from './vocabulary.ts';

/**
 * The revolve axis slot, narrowed to the three forms the kernel resolves.
 * Anything else — a keep chip the client failed to resolve, a malformed pick
 * — is a bad request, not a silent fall back to a world axis.
 */
export function parseAxis(value: GhostBody['axis']): GhostAxisRef | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (value.kind === 'standard') {
    return typeof value.axis === 'string' && STANDARD_AXES.includes(value.axis)
      ? { kind: 'standard', axis: value.axis as 'x' | 'y' | 'z' }
      : null;
  }
  if (value.kind === 'axis') {
    return typeof value.filePath === 'string' && typeof value.line === 'number'
      ? { kind: 'axis', filePath: value.filePath, line: value.line }
      : null;
  }
  if (value.kind === 'edge') {
    return typeof value.shapeId === 'string' && typeof value.index === 'number'
      ? { kind: 'edge', shapeId: value.shapeId, index: value.index }
      : null;
  }
  return null;
}

/**
 * The helix's single source slot. The three axis forms mirror {@link parseAxis}
 * — a picked edge arrives as `axis-edge`, since the helix dialog writes an edge
 * pick as `axis(<edge>)` — and the two the helix adds are a cylindrical/conical
 * face and a bare edge source. As with the axis slot, a keep chip the client
 * couldn't address never travels: it is a bad request, not a silent default.
 */
export function parseHelixSource(value: unknown): GhostHelixSourceRef | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const source = value as { kind?: unknown; axis?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  if (source.kind === 'standard') {
    return typeof source.axis === 'string' && STANDARD_AXES.includes(source.axis)
      ? { kind: 'standard', axis: source.axis as 'x' | 'y' | 'z' }
      : null;
  }
  if (source.kind === 'axis') {
    return typeof source.filePath === 'string' && typeof source.line === 'number'
      ? { kind: 'axis', filePath: source.filePath, line: source.line }
      : null;
  }
  if (source.kind === 'axis-edge' || source.kind === 'edge' || source.kind === 'face') {
    return typeof source.shapeId === 'string' && typeof source.index === 'number'
      ? { kind: source.kind, shapeId: source.shapeId, index: source.index }
      : null;
  }
  return null;
}

/**
 * The sweep's path slot: a wire statement by call site (a sketch or a helix),
 * or the picked edges the apply writes as a selector. The client resolves its
 * kept chip to one of the two before asking, so an unrecognized entry — or an
 * empty pick list, which names no spine at all — is a malformed request.
 */
export function parsePath(value: unknown): GhostPathRef | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const path = value as { kind?: unknown; filePath?: unknown; line?: unknown; entities?: unknown };
  if (path.kind === 'wire') {
    return typeof path.filePath === 'string' && typeof path.line === 'number'
      ? { kind: 'wire', filePath: path.filePath, line: path.line }
      : null;
  }
  if (path.kind !== 'edges' || !Array.isArray(path.entities) || path.entities.length === 0) {
    return null;
  }
  const entities: { shapeId: string; index: number }[] = [];
  for (const raw of path.entities) {
    const entity = raw as { shapeId?: unknown; index?: unknown };
    if (!entity || typeof entity.shapeId !== 'string' || typeof entity.index !== 'number') {
      return null;
    }
    entities.push({ shapeId: entity.shapeId, index: entity.index });
  }
  return { kind: 'edges', entities };
}

/**
 * The loft's ordered sections: sketches by call site and face picks by
 * `{shapeId, index}`. The client resolves its kept chips to one of the two
 * before asking, so an unrecognized entry is a malformed request.
 */
export function parseSections(value: unknown): GhostSectionRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const sections: GhostSectionRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const section = raw as { kind?: unknown; filePath?: unknown; line?: unknown; entities?: unknown };
    if (section.kind === 'sketch') {
      if (typeof section.filePath !== 'string' || typeof section.line !== 'number') {
        return null;
      }
      sections.push({ kind: 'sketch', filePath: section.filePath, line: section.line });
      continue;
    }
    if (section.kind !== 'faces' || !Array.isArray(section.entities) || section.entities.length === 0) {
      return null;
    }
    const entities: { shapeId: string; index: number }[] = [];
    for (const rawEntity of section.entities) {
      const entity = rawEntity as { shapeId?: unknown; index?: unknown };
      if (!entity || typeof entity.shapeId !== 'string' || typeof entity.index !== 'number') {
        return null;
      }
      entities.push({ shapeId: entity.shapeId, index: entity.index });
    }
    sections.push({ kind: 'faces', entities });
  }
  return sections;
}

/**
 * The fillet/chamfer dialog's picked edges. Every pick names the solid it was
 * made on, so a selection spanning two bodies stays addressable; an entry the
 * client couldn't resolve is a malformed request, not a partial ghost.
 */
export function parseEntityRefs(value: unknown): GhostEntityRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const refs: GhostEntityRef[] = [];
  for (const raw of value) {
    const entity = raw as { shapeId?: unknown; index?: unknown; kind?: unknown };
    if (!entity || typeof entity.shapeId !== 'string' || typeof entity.index !== 'number'
      || (entity.kind !== 'edge' && entity.kind !== 'face')) {
      return null;
    }
    refs.push({ shapeId: entity.shapeId, index: entity.index, kind: entity.kind });
  }
  return refs;
}

/**
 * A sketch-op dialog's picked sketch edges: one shapeId names one sketch
 * edge, no sub-shape indices (the 2D pick invariant). An EMPTY list is valid
 * — the target-less form (`offset(d)`, `fillet(r)`), which works the whole
 * active sketch — so only a missing or malformed entry refuses.
 */
export function parseSketchEntityRefs(value: unknown): { shapeId: string }[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const refs: { shapeId: string }[] = [];
  for (const raw of value) {
    const entity = raw as { shapeId?: unknown };
    if (!entity || typeof entity.shapeId !== 'string') {
      return null;
    }
    refs.push({ shapeId: entity.shapeId });
  }
  return refs;
}

/** Statement refs — the loft's guide rails, each a sketch or a helix. */
export function parseSourceRefs(value: unknown): { filePath: string; line: number }[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const refs: { filePath: string; line: number }[] = [];
  for (const raw of value) {
    const ref = raw as { filePath?: unknown; line?: unknown };
    if (!ref || typeof ref.filePath !== 'string' || typeof ref.line !== 'number') {
      return null;
    }
    refs.push({ filePath: ref.filePath, line: ref.line });
  }
  return refs;
}

/**
 * The mirror dialog's plane slot, narrowed to the three forms the kernel
 * resolves — the plane sibling of {@link parseAxis}. Anything else, a keep
 * chip the client failed to resolve included, is a bad request rather than a
 * silent fall back to an origin plane.
 */
export function parsePlane(value: unknown): GhostPlaneRef | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const plane = value as { kind?: unknown; plane?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  if (plane.kind === 'standard') {
    return typeof plane.plane === 'string' && STANDARD_PLANES.includes(plane.plane)
      ? { kind: 'standard', plane: plane.plane as 'xy' | 'xz' | 'yz' }
      : null;
  }
  if (plane.kind === 'plane') {
    return typeof plane.filePath === 'string' && typeof plane.line === 'number'
      ? { kind: 'plane', filePath: plane.filePath, line: plane.line }
      : null;
  }
  if (plane.kind === 'face') {
    return typeof plane.shapeId === 'string' && typeof plane.index === 'number'
      ? { kind: 'face', shapeId: plane.shapeId, index: plane.index }
      : null;
  }
  return null;
}

/**
 * One base of the plane dialog: the mirror plane's three forms, plus the edge
 * form's own two — a picked edge, and a statement drawing a single curve. As
 * with every other slot on this wire, a keep chip the client couldn't address
 * is a bad request rather than a silent fall back to an origin plane.
 */
function parsePlaneBase(value: unknown): GhostPlaneBaseRef | null {
  const base = value as { kind?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  if (base?.kind === 'wire') {
    return typeof base.filePath === 'string' && typeof base.line === 'number'
      ? { kind: 'wire', filePath: base.filePath, line: base.line }
      : null;
  }
  if (base?.kind === 'edge') {
    return typeof base.shapeId === 'string' && typeof base.index === 'number'
      ? { kind: 'edge', shapeId: base.shapeId, index: base.index }
      : null;
  }
  return parsePlane(value);
}

/**
 * The dialog's base list, checked against the form it belongs to: one base for
 * an offset or edge plane, two for a mid plane — the same counts
 * `validatePlaneBaseList` enforces on the apply path. The edge form takes only
 * an edge source; the other two only a plane one, so a request can't ghost a
 * plane the apply would refuse to write.
 */
export function parsePlaneBases(value: unknown, type: 'offset' | 'mid' | 'edge'): GhostPlaneBaseRef[] | string {
  if (!Array.isArray(value) || value.length !== (type === 'mid' ? 2 : 1)) {
    return type === 'mid' ? 'A mid plane takes two bases' : `An ${type} plane takes one base`;
  }
  const bases: GhostPlaneBaseRef[] = [];
  for (const raw of value) {
    const base = parsePlaneBase(raw);
    if (!base) {
      return 'Invalid plane base';
    }
    const isEdgeSource = base.kind === 'wire' || base.kind === 'edge';
    if (isEdgeSource !== (type === 'edge')) {
      return type === 'edge'
        ? 'An edge plane takes an edge, a sketch curve or a helix'
        : 'That plane type takes a face or a plane';
    }
    bases.push(base);
  }
  return bases;
}

/** The repeat's axis slots — one per linear direction, or one on its own. */
export function parseAxes(value: unknown): GhostAxisRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const axes: GhostAxisRef[] = [];
  for (const raw of value) {
    const axis = parseAxis(raw as GhostBody['axis']);
    if (!axis) {
      return null;
    }
    axes.push(axis);
  }
  return axes;
}

/**
 * The 2D copy's direction slots: sketch-plane axes (the Sketch X / Sketch Y
 * quick buttons) and picked sketch lines by shapeId. The 3D family's
 * axis-statement and standard-axis forms never appear here.
 */
export function parseSketchAxes(value: unknown): GhostSketchAxisRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const axes: GhostSketchAxisRef[] = [];
  for (const raw of value) {
    const axis = raw as { kind?: unknown; axis?: unknown; shapeId?: unknown };
    if (axis?.kind === 'local' && (axis.axis === 'x' || axis.axis === 'y')) {
      axes.push({ kind: 'local', axis: axis.axis });
    } else if (axis?.kind === 'edge' && typeof axis.shapeId === 'string') {
      axes.push({ kind: 'edge', shapeId: axis.shapeId });
    } else {
      return null;
    }
  }
  return axes;
}
