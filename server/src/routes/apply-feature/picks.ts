// Pick payloads: the {shapeId, sub} references the UI sends and their validators.

import type { SelectionBoundary } from '../../fluidcad-server.ts';

type RawPick = { shapeId?: unknown; sub?: { type?: unknown; index?: unknown } };

export type Pick = { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };

export type VertexPick = { shapeId: string; sub: { type: 'vertex'; index: number } };

export function validatePick(raw: RawPick | undefined): Pick | null;

export function validatePick(raw: RawPick | undefined, kind: 'vertex'): VertexPick | null;

export function validatePick(raw: RawPick | undefined, kind?: 'vertex'): Pick | VertexPick | null {
  // Existing feature slots still accept only faces/edges. A point slot opts
  // into vertices explicitly so a stale pick cannot change its meaning.
  const validType = kind === 'vertex' ? raw?.sub?.type === 'vertex'
    : raw?.sub?.type === 'edge' || raw?.sub?.type === 'face';
  const validIndex = Number.isInteger(raw?.sub?.index) && (raw!.sub!.index as number) >= 0;
  if (!raw || typeof raw.shapeId !== 'string' || !raw.shapeId || !validType || !validIndex) {
    return null;
  }
  return {
    shapeId: raw.shapeId,
    sub: { type: raw.sub!.type, index: raw.sub!.index },
  } as Pick | VertexPick;
}

export function validatePicks(entities: unknown): Pick[] | null {
  if (!Array.isArray(entities) || entities.length < 1) {
    return null;
  }
  const picks = [];
  for (const raw of entities as RawPick[]) {
    const pick = validatePick(raw);
    if (!pick) {
      return null;
    }
    picks.push(pick);
  }
  return picks;
}

/** Sketch-edge picks (2D branch): bare {shapeId} refs, one sketch edge each. */
export function validateSketchPicks(entities: unknown): { shapeId: string }[] | null {
  if (!Array.isArray(entities) || entities.length < 1) {
    return null;
  }
  const picks: { shapeId: string }[] = [];
  for (const raw of entities as { shapeId?: unknown }[]) {
    if (!raw || typeof raw.shapeId !== 'string' || raw.shapeId.length === 0) {
      return null;
    }
    picks.push({ shapeId: raw.shapeId });
  }
  return picks;
}

/**
 * Optional edit-mode boundary on selection queries: scope the query to the
 * scene objects strictly before the statement being edited. `undefined` when
 * the request carries none, null when it carries a malformed one.
 */
export function validateBoundary(raw: any): SelectionBoundary | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const valid = Number.isInteger(raw.index) && raw.index >= 0
    && typeof raw.type === 'string' && raw.type.length > 0
    && Number.isInteger(raw.line) && raw.line >= 1
    && Number.isInteger(raw.column) && raw.column >= 0;
  if (!valid) {
    return null;
  }
  return { index: raw.index, type: raw.type, line: raw.line, column: raw.column };
}

/** Tangent chains: `{seed, members}` groups; absent/empty is fine. */
export function validateChains(chains: unknown): { seed: Pick; members: Pick[] }[] | null {
  if (chains === undefined || chains === null) {
    return [];
  }
  if (!Array.isArray(chains)) {
    return null;
  }
  const result = [];
  for (const raw of chains as { seed?: RawPick; members?: unknown }[]) {
    const seed = validatePick(raw?.seed);
    const members = validatePicks(raw?.members);
    if (!seed || !members) {
      return null;
    }
    result.push({ seed, members });
  }
  return result;
}
