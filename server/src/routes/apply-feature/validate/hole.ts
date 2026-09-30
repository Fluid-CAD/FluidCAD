// hole request validation: the dialog's option values, the placements and the scope.

import {
  validConnectorAnchor,
  validHoleOptions,
  type ConnectorAnchorSpec,
  type HoleValueOptions,
} from '../../../apply-feature-edit/index.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick, type VertexPick } from '../picks.ts';

/** One placement as the dialog sends it. */
export type HolePlacementInput =
  | ({ kind: 'connector' } & SketchLoc)
  | { kind: 'vertex'; pick: VertexPick }
  | { kind: 'anchor'; pick: Pick; anchor: ConnectorAnchorSpec; name: string }
  | { kind: 'verbatim'; sourceIndex: number };

export type HoleRequest = HoleValueOptions & {
  placements: HolePlacementInput[];
  scope: SketchLoc[];
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
    flip: body?.flip === true,
  };
  if (!validHoleOptions(options)) {
    return { error: "hole options must carry a size ({kind: 'diameter', value} or {kind: 'fastener', label}), "
      + 'a fastener (clearance fit or tapped pitch, fastener sizes only), a style (counterbore or countersink), '
      + 'a positive depth or null, a tip angle only with a depth, and a boolean flip' };
  }
  return options;
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
      placements.push({ kind: 'connector', ...loc });
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
  return { ...options, placements: placements.placements!, scope: scope.scope };
}
