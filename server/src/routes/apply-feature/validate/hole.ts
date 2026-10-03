// hole request validation: the dialog's option values, the placements and the scope.

import {
  validConnectorAnchor,
  validValueExpr,
  validHoleOptions,
  validHolePlacementSlot,
  type ConnectorAnchorSpec,
  type HoleValueOptions,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick, type VertexPick } from '../picks.ts';

/**
 * One placement as the dialog sends it. A connector is its `connector()`
 * statement — plus the slot of one of its copies (`bolt.instance(2)`).
 */
export type HolePlacementInput =
  | ({ kind: 'connector'; slot?: number } & SketchLoc)
  | { kind: 'vertex'; pick: VertexPick }
  | { kind: 'anchor'; pick: Pick; anchor: ConnectorAnchorSpec; name: string }
  | { kind: 'verbatim'; sourceIndex: number };

/**
 * The `.fasten(…)` chain as the dialog sends it: the mating solid by its
 * statement — or, on an edit, the statement's own argument kept (`verbatim`)
 * — the tapped hole's pitch (null is coarse) and its blind depth (null is
 * through all).
 */
export type HoleFastenInput = {
  target: { kind: 'verbatim' } | ({ kind: 'feature' } & SketchLoc);
  pitch: number | null;
  depth: ValueExpr | null;
};

export type HoleRequest = HoleValueOptions & {
  placements: HolePlacementInput[];
  scope: SketchLoc[];
  fasten: HoleFastenInput | null;
};

export const MAX_HOLE_PLACEMENTS = 64;

const CONNECTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The option fields both hole requests carry — the same shape the transform validates. */
export function validateHoleOptions(body: any): HoleValueOptions | { error: string } {
  const options = {
    size: body?.size,
    fastener: body?.fastener ?? null,
    style: body?.style ?? null,
    depth: body?.depth ?? null,
    tipAngle: body?.tipAngle ?? null,
  };
  if (!validHoleOptions(options)) {
    return { error: "hole options must carry a size ({kind: 'diameter', value} or {kind: 'fastener', label}), "
      + 'a fastener (clearance fit or tapped pitch, fastener sizes only), a style (counterbore or countersink), '
      + 'a positive depth or null, and a tip angle only with a depth' };
  }
  return options;
}

/**
 * The `fasten` field: null or absent on a create writes no chain; on an edit
 * absent keeps the statement's own (`undefined`) and null drops it. Clearance
 * holes of a fastener size only.
 */
export function validateHoleFasten(body: any, options: HoleValueOptions, edit: boolean):
  { fasten: HoleFastenInput | null | undefined } | { error: string } {
  const raw = body?.fasten;
  if (raw === undefined) {
    return { fasten: edit ? undefined : null };
  }
  if (raw === null) {
    return { fasten: null };
  }
  if (options.size.kind !== 'fastener' || options.fastener?.type === 'tapped') {
    return { error: 'fasten goes with a clearance hole of a fastener size — the mating solid takes the tapped hole' };
  }
  const pitch = raw.pitch ?? null;
  if (pitch !== null && (typeof pitch !== 'number' || !Number.isFinite(pitch) || pitch <= 0)) {
    return { error: 'the fasten pitch must be a positive number, or null for the coarse pitch' };
  }
  const depth = raw.depth ?? null;
  if (depth !== null && !validValueExpr(depth, { positive: true })) {
    return { error: 'the fasten depth must be a positive number or expression, or null for through all' };
  }
  if (edit && raw.target?.kind === 'verbatim') {
    return { fasten: { target: { kind: 'verbatim' }, pitch, depth } };
  }
  const loc = validateSketchLoc(raw.target);
  if (!loc) {
    return { error: 'the fasten target must be the {filePath, line} of a solid statement' };
  }
  return { fasten: { target: { kind: 'feature', ...loc }, pitch, depth } };
}

/**
 * The placement list. On a create every entry is a pick; an edit may keep
 * entries by their position in the statement (`verbatim`). Absent on an edit
 * keeps every placement as written.
 */
export function validateHolePlacements(raw: unknown, edit: boolean):
  { placements: HolePlacementInput[] | undefined } | { error: string } {
  if (raw === undefined || raw === null) {
    return edit ? { placements: undefined } : { error: 'placements must list where the holes go' };
  }
  if (!Array.isArray(raw) || raw.length > MAX_HOLE_PLACEMENTS) {
    return { error: `placements must be 1-${MAX_HOLE_PLACEMENTS} connectors, sketch vertices or face/edge anchors` };
  }
  if (raw.length === 0 && !edit) {
    return { error: 'pick at least one placement — a connector, a sketch vertex or a face' };
  }
  const placements: HolePlacementInput[] = [];
  const seenIndices = new Set<number>();
  for (const entry of raw) {
    if (entry?.kind === 'connector') {
      const loc = validateSketchLoc(entry);
      if (!loc) {
        return { error: 'a connector placement must be the {filePath, line, column} of the connector statement' };
      }
      const slot = entry.slot ?? undefined;
      if (!validHolePlacementSlot(slot)) {
        return { error: 'a connector placement slot must be a whole number counting from 0' };
      }
      placements.push(slot === undefined ? { kind: 'connector', ...loc } : { kind: 'connector', ...loc, slot });
    } else if (entry?.kind === 'vertex') {
      const pick = validatePick(entry.entity, 'vertex');
      if (!pick) {
        return { error: 'a vertex placement must carry a {shapeId, sub:{type:"vertex", index}} pick' };
      }
      placements.push({ kind: 'vertex', pick });
    } else if (entry?.kind === 'anchor') {
      const pick = validatePick(entry.entity);
      if (!pick) {
        return { error: 'an anchor placement must carry a {shapeId, sub:{type:"face"|"edge", index}} pick' };
      }
      const anchor = entry.anchor ?? { kind: 'center' };
      if (!validConnectorAnchor(anchor) || anchor === undefined) {
        return { error: "an anchor placement's anchor must be {kind: 'center'|'start'|'end'} or {kind: 'offset', mode, value}" };
      }
      const name = entry.name ?? 'h1';
      if (typeof name !== 'string' || name.length > 64 || !CONNECTOR_NAME.test(name)) {
        return { error: "an anchor placement's name must be a plain identifier (the connector it may create)" };
      }
      placements.push({ kind: 'anchor', pick, anchor, name });
    } else if (edit && entry?.kind === 'verbatim') {
      if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0 || seenIndices.has(entry.sourceIndex)) {
        return { error: 'each kept placement must carry a distinct {sourceIndex} into the statement' };
      }
      seenIndices.add(entry.sourceIndex);
      placements.push({ kind: 'verbatim', sourceIndex: entry.sourceIndex });
    } else {
      return { error: 'each placement must be a connector, a vertex pick or a face/edge anchor' };
    }
  }
  return { placements };
}

export function validateHole(body: any): HoleRequest | { error: string } {
  const options = validateHoleOptions(body);
  if ('error' in options) {
    return options;
  }
  const placements = validateHolePlacements(body?.placements, false);
  if ('error' in placements) {
    return placements;
  }
  const scope = validateScopeLocs(body);
  if ('error' in scope) {
    return scope;
  }
  const fasten = validateHoleFasten(body, options, false);
  if ('error' in fasten) {
    return fasten;
  }
  if (fasten.fasten?.target.kind === 'feature') {
    const target = fasten.fasten.target;
    if (scope.scope.some(loc => loc.filePath === target.filePath && loc.line === target.line)) {
      return { error: 'the solid to fasten to cannot also be in the scope — it takes the tapped hole, not the clearance one' };
    }
  }
  return { ...options, placements: placements.placements!, scope: scope.scope, fasten: fasten.fasten ?? null };
}
