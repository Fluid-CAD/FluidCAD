import { Router } from 'express';
import type { FluidCadServer, SelectionBoundary } from '../fluidcad-server.ts';
import {
  applyFeatureEdit, extractNumericParams, makeProducerNamer, parseFeatureStatement, renderEditedStatement,
  renderExtrudeStatement, renderLoftStatement, renderPlaneBaseExprs, renderPlaneStatement,
  renderRepeatAxisExpr, renderRepeatPlaneExpr, renderRepeatStatement,
  renderRevolveStatement,
  renderSelectorPartExpr, renderShellJoinChain, renderSweepStatement, renderWrapStatement, resolveParamValues,
  resolveSketchNames,
  type ApplyFeatureEditSpec, type ExtrudeEditOptions, type FeatureStatementEditTarget, type LoftEditOptions,
  type PlaneEditOptions, type RepeatAxisSpec, type RepeatEditOptions, type RevolveEditOptions,
  type ShellJoinKind, type SweepEditOptions, type WrapEditOptions,
} from '../apply-feature-edit.ts';
import { normalizePath } from '../normalize-path.ts';

const MAX_ENTITIES = 32;

type RawPick = { shapeId?: unknown; sub?: { type?: unknown; index?: unknown } };

type Pick = { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };

function validatePick(raw: RawPick | undefined): Pick | null {
  const validType = raw?.sub?.type === 'edge' || raw?.sub?.type === 'face';
  const validIndex = Number.isInteger(raw?.sub?.index) && (raw!.sub!.index as number) >= 0;
  if (!raw || typeof raw.shapeId !== 'string' || !raw.shapeId || !validType || !validIndex) {
    return null;
  }
  return {
    shapeId: raw.shapeId,
    sub: { type: raw.sub!.type as 'edge' | 'face', index: raw.sub!.index as number },
  };
}

function validatePicks(entities: unknown): Pick[] | null {
  if (!Array.isArray(entities) || entities.length < 1 || entities.length > MAX_ENTITIES) {
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

/** A sketch addressed by the source location the scene render reported. */
type SketchLoc = { filePath: string; line: number; column: number };

/**
 * Optional edit-mode boundary on selection queries: scope the query to the
 * scene objects strictly before the statement being edited. `undefined` when
 * the request carries none, null when it carries a malformed one.
 */
function validateBoundary(raw: any): SelectionBoundary | undefined | null {
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

/** One or two positive `.thin()` offsets; absent means a plain feature. */
function validateThinOffsets(thin: unknown): { offsets: [number] | [number, number] | null } | { error: string } {
  if (thin === undefined || thin === null) {
    return { offsets: null };
  }
  const valid = Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every((t: unknown) => typeof t === 'number' && Number.isFinite(t) && t > 0);
  if (!valid) {
    return { error: 'thin must be one or two positive offsets' };
  }
  return { offsets: thin.length === 1 ? [thin[0]] : [thin[0], thin[1]] };
}

/** Shell's optional `.join()` type; absent means 'arc' — the kernel default. */
function validateShellJoinType(raw: unknown): { joinType: ShellJoinKind } | { error: string } {
  if (raw === undefined || raw === null) {
    return { joinType: 'arc' };
  }
  if (raw !== 'arc' && raw !== 'intersection' && raw !== 'tangent') {
    return { error: 'joinType must be "arc", "intersection" or "tangent"' };
  }
  return { joinType: raw };
}

function validateSketchLoc(loc: any): SketchLoc | null {
  const valid = loc && typeof loc.filePath === 'string' && loc.filePath.length > 0
    && Number.isInteger(loc.line) && loc.line >= 1;
  if (!valid) {
    return null;
  }
  return {
    filePath: loc.filePath,
    line: loc.line,
    column: Number.isInteger(loc.column) && loc.column >= 0 ? loc.column : 0,
  };
}

/** The dialog-editable extrude options, shared by the create and edit paths. */
type ExtrudeOptionSet = {
  op: 'add' | 'remove' | 'new';
  distance: number | null;
  distance2: number | null;
  symmetric: boolean;
  draft: number | null;
  drill: boolean;
  thin: [number] | [number, number] | null;
};

/**
 * The extrude request's shape. The profile is a sketch — `active` consumes it
 * implicitly, `bound` binds it to a variable. `toFace` is the optional
 * up-to-face target: a picked face to synthesize a selector from, which
 * replaces the distance(s).
 */
type ExtrudeRequest = ExtrudeOptionSet & {
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  toFace?: Pick;
};

function isNonzeroNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0;
}

/**
 * Validate the option fields both extrude requests carry: the boolean op,
 * the distance(s) — one, two (asymmetric both-ways), or null for a
 * through-all remove — plus the symmetric / draft / drill / thin chains.
 * `symmetric` and `distance2` are competing direction modes and exclude
 * each other; a through-all remove has no explicit distances to pair.
 * `toFace` (the create path's up-to-face mode) replaces the distances
 * entirely and excludes the symmetric direction mode.
 */
function validateExtrudeOptions(body: any, toFace = false): ExtrudeOptionSet | { error: string } {
  const { op, distance, distance2, symmetric, draft, drill, thin } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (toFace) {
    if (distance !== undefined && distance !== null) {
      return { error: 'a to-face extrude takes no distance — the target face bounds it' };
    }
  } else if (distance === null) {
    if (op !== 'remove') {
      return { error: 'distance may be null (through-all) only for a remove' };
    }
  } else if (!isNonzeroNumber(distance)) {
    return { error: 'distance must be a nonzero number (negative extrudes the other way)' };
  }
  if (distance2 !== undefined && distance2 !== null) {
    if (toFace) {
      return { error: 'a to-face extrude takes no second distance' };
    }
    if (!isNonzeroNumber(distance2)) {
      return { error: 'distance2 must be a nonzero number' };
    }
    if (distance === null) {
      return { error: 'a two-distance extrude cannot be through-all' };
    }
    if (symmetric === true) {
      return { error: 'a two-distance extrude cannot be symmetric' };
    }
  }
  if (symmetric !== undefined && typeof symmetric !== 'boolean') {
    return { error: 'symmetric must be a boolean' };
  }
  if (symmetric === true && toFace) {
    return { error: 'a to-face extrude cannot be symmetric' };
  }
  if (draft !== undefined && draft !== null && !isNonzeroNumber(draft)) {
    return { error: 'draft must be a nonzero taper angle in degrees' };
  }
  if (drill !== undefined && typeof drill !== 'boolean') {
    return { error: 'drill must be a boolean' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  return {
    op,
    distance: distance ?? null,
    distance2: distance2 ?? null,
    symmetric: symmetric === true,
    draft: draft ?? null,
    drill: drill !== false,
    thin: thinResult.offsets,
  };
}

function validateExtrude(body: any): ExtrudeRequest | { error: string } {
  const hasToFace = body?.toFace !== undefined && body?.toFace !== null;
  const options = validateExtrudeOptions(body, hasToFace);
  if ('error' in options) {
    return options;
  }
  const mode = body?.profile?.mode;
  const loc = validateSketchLoc(body?.profile);
  if ((mode !== 'active' && mode !== 'bound') || !loc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  if (!hasToFace) {
    return { ...options, profile: { mode, ...loc } };
  }
  const pick = validatePick(body.toFace);
  if (!pick || pick.sub.type !== 'face') {
    return { error: 'toFace must be a {shapeId, sub:{type:"face", index}} pick' };
  }
  return { ...options, profile: { mode, ...loc }, toFace: pick };
}

/**
 * The sweep request's shape: the profile is a sketch (like extrude); the
 * path is either another sketch or edge picks to synthesize a selector from.
 */
type SweepRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  path:
    | ({ kind: 'sketch' } & SketchLoc)
    | { kind: 'edges'; picks: Pick[]; chains: { seed: Pick; members: Pick[] }[] };
};

function validateSweep(body: any): SweepRequest | { error: string } {
  const { op, thin, profile, path } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const mode = profile?.mode;
  const profileLoc = validateSketchLoc(profile);
  if ((mode !== 'active' && mode !== 'bound') || !profileLoc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const base = { op, thin: thinResult.offsets, profile: { mode, ...profileLoc } };
  if (path?.kind === 'sketch') {
    const pathLoc = validateSketchLoc(path);
    if (!pathLoc) {
      return { error: 'a sketch path must carry the sketch {filePath, line}' };
    }
    if (pathLoc.filePath !== profileLoc.filePath) {
      return { error: 'the profile and path sketches live in different files' };
    }
    if (pathLoc.line === profileLoc.line) {
      return { error: 'the profile and path must be different sketches' };
    }
    return { ...base, path: { kind: 'sketch', ...pathLoc } };
  }
  if (path?.kind === 'edges') {
    const picks = validatePicks(path.entities);
    if (!picks) {
      return { error: `path entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` };
    }
    const chains = validateChains(path.chains);
    if (!chains) {
      return { error: 'path chains must be {seed, members} pick groups' };
    }
    return { ...base, path: { kind: 'edges', picks, chains } };
  }
  return { error: 'path must be {kind: "sketch", filePath, line} or {kind: "edges", entities}' };
}

/**
 * The wrap request's shape: the sketch is always an explicit input (wrap()
 * never consumes the active sketch implicitly), the target face is a pick to
 * synthesize a selector from, and the thickness is the pad height along the
 * surface normal.
 */
type WrapRequest = {
  op: 'add' | 'remove' | 'new';
  thickness: number;
  sketch: SketchLoc;
  face: Pick;
};

function validateWrap(body: any): WrapRequest | { error: string } {
  const { op, thickness, sketch } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (typeof thickness !== 'number' || !Number.isFinite(thickness) || thickness <= 0) {
    return { error: 'thickness must be a positive number' };
  }
  const sketchLoc = validateSketchLoc(sketch);
  if (!sketchLoc) {
    return { error: 'sketch must be the {filePath, line} of the sketch to wrap' };
  }
  const pick = validatePick(body?.face);
  if (!pick || pick.sub.type !== 'face') {
    return { error: 'face must be a {shapeId, sub:{type:"face", index}} pick' };
  }
  return { op, thickness, sketch: sketchLoc, face: pick };
}

/**
 * One revolve axis input: a standard world axis string, an existing axis
 * statement addressed by its source location, or a picked edge to synthesize
 * an `axis(<selector>)` from.
 */
type RevolveAxisInput =
  | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
  | { kind: 'axis'; loc: SketchLoc }
  | { kind: 'edge'; pick: Pick };

/**
 * The revolve request's shape: the profile is a sketch (like extrude); the
 * axis is a standard world axis, an existing axis statement, or a picked
 * edge. The angle is in degrees — 360 (the API default) renders no argument.
 */
type RevolveRequest = {
  op: 'add' | 'remove' | 'new';
  angle: number;
  thin: [number] | [number, number] | null;
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  axis: RevolveAxisInput;
};

/** One revolve axis field: standard string, axis statement, or edge pick. */
function validateRevolveAxis(raw: any): RevolveAxisInput | { error: string } {
  if (raw?.kind === 'standard') {
    if (raw.axis !== 'x' && raw.axis !== 'y' && raw.axis !== 'z') {
      return { error: 'a standard axis must be "x", "y" or "z"' };
    }
    return { kind: 'standard', axis: raw.axis };
  }
  if (raw?.kind === 'axis') {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'an axis input must carry the axis {filePath, line}' };
    }
    return { kind: 'axis', loc };
  }
  if (raw?.kind === 'edge') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'edge') {
      return { error: 'a picked axis must carry a {shapeId, sub:{type:"edge", index}} pick' };
    }
    return { kind: 'edge', pick };
  }
  return { error: 'axis must be {kind: "standard"|"axis"|"edge", …}' };
}

function validateRevolve(body: any): RevolveRequest | { error: string } {
  const { op, angle, thin, profile } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (!isNonzeroNumber(angle)) {
    return { error: 'angle must be a nonzero sweep angle in degrees' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const mode = profile?.mode;
  const profileLoc = validateSketchLoc(profile);
  if ((mode !== 'active' && mode !== 'bound') || !profileLoc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  if (axis.kind === 'axis' && axis.loc.filePath !== profileLoc.filePath) {
    return { error: 'the axis and the profile sketch live in different files' };
  }
  return { op, angle, thin: thinResult.offsets, profile: { mode, ...profileLoc }, axis };
}

/** Ordered loft profile inputs: sketches and picked faces, mixed freely. */
type LoftProfileInput = ({ kind: 'sketch' } & SketchLoc) | { kind: 'face'; pick: Pick };

type LoftCondition = { type: 'normal' | 'tangent'; magnitude: number };

type LoftRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [number] | [number, number] | null;
  profiles: LoftProfileInput[];
  guides: SketchLoc[];
  startCondition: LoftCondition | null;
  endCondition: LoftCondition | null;
};

const MAX_LOFT_PROFILES = 16;

/**
 * One `.startCondition()`/`.endCondition()` request field: absent/null means
 * no chain ('none' never reaches the wire — it only clears the dialog field).
 */
function validateLoftCondition(
  which: string,
  raw: unknown,
): { condition: LoftCondition | null } | { error: string } {
  if (raw === undefined || raw === null) {
    return { condition: null };
  }
  const { type, magnitude } = raw as { type?: unknown; magnitude?: unknown };
  if (type !== 'normal' && type !== 'tangent') {
    return { error: `${which} type must be "normal" or "tangent"` };
  }
  if (typeof magnitude !== 'number' || !Number.isFinite(magnitude) || magnitude === 0) {
    return { error: `${which} magnitude must be a nonzero number` };
  }
  return { condition: { type, magnitude } };
}

/**
 * The loft request's shape: two or more ordered profiles, each a sketch or a
 * picked face. Order is the loft's argument order. Up to two guide sketches
 * and the start/end takeoff conditions ride along. Duplicates are rejected
 * here — the same sketch or face twice is never a valid loft, and a profile
 * can't double as a guide (a guide must cross every profile, so a curve lying
 * IN a profile can never be one). Guides exclude thin mode (kernel rule).
 */
function validateLoft(body: any): LoftRequest | { error: string } {
  const { op, thin, profiles, guides } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  const thinResult = validateThinOffsets(thin);
  if ('error' in thinResult) {
    return thinResult;
  }
  const startResult = validateLoftCondition('startCondition', body?.startCondition);
  if ('error' in startResult) {
    return startResult;
  }
  const endResult = validateLoftCondition('endCondition', body?.endCondition);
  if ('error' in endResult) {
    return endResult;
  }
  if (!Array.isArray(profiles) || profiles.length < 2 || profiles.length > MAX_LOFT_PROFILES) {
    return { error: `profiles must be 2-${MAX_LOFT_PROFILES} ordered loft profiles` };
  }
  const result: LoftProfileInput[] = [];
  const seen = new Set<string>();
  let filePath: string | null = null;
  for (const raw of profiles) {
    if (raw?.kind === 'sketch') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a sketch profile must carry the sketch {filePath, line}' };
      }
      if (filePath !== null && loc.filePath !== filePath) {
        return { error: 'the profile sketches live in different files' };
      }
      filePath = loc.filePath;
      const key = `sketch:${loc.filePath}:${loc.line}`;
      if (seen.has(key)) {
        return { error: 'each profile must be a different sketch' };
      }
      seen.add(key);
      result.push({ kind: 'sketch', ...loc });
    } else if (raw?.kind === 'face') {
      const pick = validatePick(raw.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a face profile must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      const key = `face:${pick.shapeId}:${pick.sub.index}`;
      if (seen.has(key)) {
        return { error: 'the same face was picked twice — each profile must be different' };
      }
      seen.add(key);
      result.push({ kind: 'face', pick });
    } else {
      return { error: 'each profile must be {kind: "sketch", filePath, line} or {kind: "face", entity}' };
    }
  }
  const guideLocs: SketchLoc[] = [];
  if (guides !== undefined && guides !== null) {
    if (!Array.isArray(guides) || guides.length > 2) {
      return { error: 'guides must be at most two guide sketches' };
    }
    for (const raw of guides) {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a guide must carry the sketch {filePath, line}' };
      }
      if (filePath !== null && loc.filePath !== filePath) {
        return { error: 'the guide sketches live in a different file than the profiles' };
      }
      filePath = loc.filePath;
      const key = `sketch:${loc.filePath}:${loc.line}`;
      if (seen.has(key)) {
        return { error: 'a guide must be a different sketch from every profile and other guide' };
      }
      seen.add(key);
      guideLocs.push(loc);
    }
  }
  if (guideLocs.length > 0 && thinResult.offsets) {
    return { error: 'loft guides cannot be combined with thin walls' };
  }
  return {
    op, thin: thinResult.offsets, profiles: result, guides: guideLocs,
    startCondition: startResult.condition, endCondition: endResult.condition,
  };
}

/** One base of a plane request: a standard plane, a viewport pick, or an existing plane feature. */
type PlaneBaseInput =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'pick'; pick: Pick }
  | { kind: 'plane'; loc: SketchLoc };

type PlaneRequest = {
  type: 'offset' | 'mid' | 'edge';
  offset: number | null;
  rotateX: number | null;
  rotateY: number | null;
  rotateZ: number | null;
  position: number | null;
  bases: PlaneBaseInput[];
};

/**
 * The plane request's shape: one base for an offset plane, two for a mid
 * plane — each a standard origin plane, a picked face/edge, or an existing
 * plane feature addressed by its source location — or a single picked EDGE
 * plus a normalized 0–1 position for an edge plane. The offset and per-axis
 * rotations are optional (offset/mid only — the edge form's second argument
 * is the position); duplicates are rejected (a mid plane between a base and
 * itself is degenerate).
 */
function validatePlane(body: any): PlaneRequest | { error: string } {
  const { type, bases } = body ?? {};
  if (type !== 'offset' && type !== 'mid' && type !== 'edge') {
    return { error: 'type must be "offset", "mid" or "edge"' };
  }
  const numbers: Record<string, number | null> = {};
  for (const key of ['offset', 'rotateX', 'rotateY', 'rotateZ', 'position'] as const) {
    const raw = body?.[key];
    if (raw === undefined || raw === null) {
      numbers[key] = null;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { error: `${key} must be a finite number` };
    }
    numbers[key] = raw;
  }
  if (type === 'edge') {
    if (numbers.position === null || numbers.position < 0 || numbers.position > 1) {
      return { error: 'position must be a number between 0 (start) and 1 (end)' };
    }
    if (numbers.offset !== null || numbers.rotateX !== null || numbers.rotateY !== null || numbers.rotateZ !== null) {
      return { error: 'an edge plane takes a position only — no offset or rotation' };
    }
  } else if (numbers.position !== null) {
    return { error: 'position is only valid for an edge plane' };
  }
  const expected = type === 'mid' ? 2 : 1;
  if (!Array.isArray(bases) || bases.length !== expected) {
    return {
      error: type === 'mid'
        ? 'a mid plane takes exactly two bases'
        : `an ${type} plane takes exactly one base`,
    };
  }
  const result: PlaneBaseInput[] = [];
  const seen = new Set<string>();
  for (const raw of bases) {
    let key: string;
    if (raw?.kind === 'standard') {
      if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
        return { error: 'a standard base must be "xy", "xz" or "yz"' };
      }
      key = `standard:${raw.plane}`;
      result.push({ kind: 'standard', plane: raw.plane });
    } else if (raw?.kind === 'pick') {
      const pick = validatePick(raw.entity);
      if (!pick) {
        return { error: 'a picked base must carry a {shapeId, sub:{type, index}} pick' };
      }
      key = `pick:${pick.shapeId}:${pick.sub.type}:${pick.sub.index}`;
      result.push({ kind: 'pick', pick });
    } else if (raw?.kind === 'plane') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a plane base must carry the plane {filePath, line}' };
      }
      key = `plane:${loc.filePath}:${loc.line}`;
      result.push({ kind: 'plane', loc });
    } else {
      return { error: 'each base must be {kind: "standard"|"pick"|"plane", …}' };
    }
    if (seen.has(key)) {
      return { error: 'the two bases must be different' };
    }
    seen.add(key);
  }
  if (type === 'edge' && (result[0].kind !== 'pick' || result[0].pick.sub.type !== 'edge')) {
    return { error: 'an edge plane takes a single picked edge as its base' };
  }
  return {
    type,
    offset: numbers.offset,
    rotateX: numbers.rotateX,
    rotateY: numbers.rotateY,
    rotateZ: numbers.rotateZ,
    position: numbers.position,
    bases: result,
  };
}

/** The mirror plane of a repeat request: a standard plane, an existing plane feature, or a picked face. */
type RepeatPlaneInput =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; loc: SketchLoc }
  | { kind: 'face'; pick: Pick };

/** One linear direction: its axis plus that direction's count and value. */
type RepeatDirectionInput = { axis: RevolveAxisInput; count: number; value: number };

type RepeatRequest = {
  kind: 'linear' | 'circular' | 'mirror' | 'rotate';
  /** The feature statements being repeated, in argument order. */
  targets: SketchLoc[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: RepeatDirectionInput[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  axis?: RevolveAxisInput;
  plane?: RepeatPlaneInput;
  count?: number;
  sweep?: { mode: 'angle' | 'offset'; value: number };
  centered?: boolean;
  angle?: number;
};

const MAX_REPEAT_TARGETS = 16;
const MAX_REPEAT_DIRECTIONS = 3;

/**
 * The repeat request's shape: the kind, one or more target feature
 * statements addressed by their source locations, plus the kind's inputs —
 * linear directions (each an axis with its own count and value, sharing one
 * offset/length spacing mode), a single axis for circular/rotate (a standard
 * world axis, an existing axis statement, or a picked edge), or a mirror
 * plane (a standard origin plane, an existing plane feature, or a picked
 * face), and the numeric options (count with a sweep for circular, the angle
 * for rotate).
 */
function validateRepeat(body: any): RepeatRequest | { error: string } {
  const { kind, targets, count, centered, angle } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular' && kind !== 'mirror' && kind !== 'rotate') {
    return { error: 'kind must be "linear", "circular", "mirror" or "rotate"' };
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_REPEAT_TARGETS) {
    return { error: `targets must be 1-${MAX_REPEAT_TARGETS} feature statements to repeat` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the repeat targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  const filePath = targetLocs[0].filePath;

  if (kind === 'mirror') {
    for (const key of ['axis', 'directions', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a mirror repeat takes no ${key}` };
      }
    }
    const raw = body?.plane;
    let plane: RepeatPlaneInput;
    if (raw?.kind === 'standard') {
      if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
        return { error: 'a standard mirror plane must be "xy", "xz" or "yz"' };
      }
      plane = { kind: 'standard', plane: raw.plane };
    } else if (raw?.kind === 'plane') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a plane input must carry the plane {filePath, line}' };
      }
      if (loc.filePath !== filePath) {
        return { error: 'the mirror plane and the targets live in different files' };
      }
      plane = { kind: 'plane', loc };
    } else if (raw?.kind === 'face') {
      const pick = validatePick(raw.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a picked mirror plane must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      plane = { kind: 'face', pick };
    } else {
      return { error: 'plane must be {kind: "standard"|"plane"|"face", …}' };
    }
    return { kind, targets: targetLocs, plane };
  }

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} repeat takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear repeat carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
      }
    }
    if (centered !== undefined && typeof centered !== 'boolean') {
      return { error: 'centered must be a boolean' };
    }
    const spacingMode = body?.spacingMode;
    if (spacingMode !== 'offset' && spacingMode !== 'length') {
      return { error: 'spacingMode must be "offset" or "length"' };
    }
    const raw = body?.directions;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REPEAT_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_REPEAT_DIRECTIONS} axis directions` };
    }
    const directions: RepeatDirectionInput[] = [];
    for (const entry of raw) {
      const axis = validateRevolveAxis(entry?.axis);
      if ('error' in axis) {
        return axis;
      }
      if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
        return { error: 'an axis and the targets live in different files' };
      }
      if (!Number.isInteger(entry?.count) || entry.count < 2) {
        return { error: 'each direction count must be an integer of at least 2 (the original included)' };
      }
      if (!isNonzeroNumber(entry?.value)) {
        return { error: 'each direction value must be a nonzero number' };
      }
      directions.push({ axis, count: entry.count, value: entry.value });
    }
    return { kind, targets: targetLocs, directions, spacingMode, centered: centered === true };
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: `only a linear repeat takes directions` };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear repeat takes a spacingMode' };
  }
  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
    return { error: 'the axis and the targets live in different files' };
  }

  if (kind === 'rotate') {
    for (const key of ['count', 'sweep', 'centered'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a rotate repeat takes no ${key}` };
      }
    }
    if (!isNonzeroNumber(angle)) {
      return { error: 'angle must be a nonzero rotation in degrees' };
    }
    return { kind, targets: targetLocs, axis, angle };
  }

  if (!Number.isInteger(count) || count < 2) {
    return { error: 'count must be an integer of at least 2 (the original included)' };
  }
  if (angle !== undefined && angle !== null) {
    return { error: 'a circular repeat carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular repeat takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!isNonzeroNumber(sweep.value)) {
    return { error: 'sweep value must be a nonzero number' };
  }
  return {
    kind, targets: targetLocs, axis, count,
    sweep: { mode: sweep.mode, value: sweep.value },
  };
}

/**
 * Producers merged by call site across per-pick synthesis calls (and the
 * request's own sketch/plane inputs); a bind:true entry wins over an anchor.
 * Shared by the loft and plane branches.
 */
function makeProducerMerger(): {
  producers: ApplyFeatureEditSpec['producers'];
  merge: (producer: ApplyFeatureEditSpec['producers'][number]) => number;
} {
  const producers: ApplyFeatureEditSpec['producers'] = [];
  const index = new Map<string, number>();
  const merge = (producer: ApplyFeatureEditSpec['producers'][number]): number => {
    const key = `${producer.line}:${producer.column}`;
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, producers.length);
      producers.push(producer);
      return producers.length - 1;
    }
    if (producer.bind && !producers[existing].bind) {
      producers[existing] = producer;
    }
    return existing;
  };
  return { producers, merge };
}

/**
 * Truthful preview names: one namer pass over the bound producers in spec
 * order — the same allocation walk the transform runs. Unnamed producers fall
 * back to collision-suffixed hints; unbound (anchor) entries stay null.
 */
async function allocateProducerVars(
  producers: ApplyFeatureEditSpec['producers'],
  code: string | null,
): Promise<(string | null)[]> {
  const names: (string | null)[] = producers.map((): null => null);
  if (code) {
    const namer = await makeProducerNamer(code);
    const bound = producers
      .map((producer, index) => ({ producer, index }))
      .filter(entry => entry.producer.bind);
    const resolved = namer(bound.map(({ producer }) => ({
      line: producer.line, nameHint: producer.nameHint, featureType: producer.featureType,
    })));
    bound.forEach((entry, i) => {
      names[entry.index] = resolved[i];
    });
  }
  const used = new Set(names.filter((n): n is string => n !== null));
  return producers.map((producer, i) => {
    if (!producer.bind) {
      return null;
    }
    if (names[i]) {
      return names[i];
    }
    const hint = producer.nameHint || 'f';
    let name = hint;
    let suffix = 1;
    while (used.has(name)) {
      suffix++;
      name = `${hint}${suffix}`;
    }
    used.add(name);
    return name;
  });
}

/** Features whose statements the dialogs can rewrite in place. */
const EDITABLE_FEATURES = new Set(['extrude', 'sweep', 'loft', 'shell', 'fillet', 'chamfer', 'revolve', 'text', 'wrap', 'sketch']);

/** One edited loft profile as the request carries it. */
type EditLoftProfileInput =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'sketch' } & SketchLoc)
  | { kind: 'face'; pick: Pick };

/** One edited loft guide as the request carries it. */
type EditLoftGuideInput =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'sketch' } & SketchLoc);

type StatementEditRequest = {
  feature: ApplyFeatureEditSpec['feature'];
  target: SketchLoc;
  edit: FeatureStatementEditTarget;
  value?: number;
  rawArgs?: string;
  /** Re-picked selection for shell/fillet/chamfer; absent keeps the args. */
  picks?: Pick[];
  chains?: { seed: Pick; members: Pick[] }[];
  /** Re-sourced extrude profile sketch; absent keeps the statement's. */
  extrudeProfile?: SketchLoc;
  /** Re-picked extrude up-to-face target; the keep case rides the edit target. */
  extrudeToFace?: Pick;
  /** Re-sourced sweep path; absent keeps the statement's. */
  sweepPath?: ({ kind: 'sketch' } & SketchLoc)
    | { kind: 'edges'; picks: Pick[]; chains: { seed: Pick; members: Pick[] }[] };
  /** Re-sourced sweep profile sketch; absent keeps the statement's. */
  sweepProfile?: SketchLoc;
  /** Re-sourced wrap sketch; absent keeps the statement's. */
  wrapSketch?: SketchLoc;
  /** Re-picked wrap target face; absent keeps the statement's. */
  wrapFace?: Pick;
  /** Re-sourced revolve profile sketch; absent keeps the statement's. */
  revolveProfile?: SketchLoc;
  /** Re-sourced revolve axis; absent keeps the statement's. */
  revolveAxis?: RevolveAxisInput;
  /** Full replacement loft profile list; absent keeps the statement's. */
  loftProfiles?: EditLoftProfileInput[];
  /** Full replacement loft guide list; absent keeps the statement's. */
  loftGuides?: EditLoftGuideInput[];
  /**
   * The sketch retarget's new target (the sketch dialog's re-pick): a face
   * pick, an origin plane, or an existing plane() feature by call site.
   */
  sketchTarget?:
    | { kind: 'face'; pick: Pick }
    | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
    | { kind: 'planeRef'; loc: SketchLoc };
  /** True when a source payload carries picks — synthesis needs a boundary. */
  needsPicks: boolean;
};

/** A `keep`-or-absent slot value: true when the field re-sources nothing. */
function isKeepSlot(raw: any): boolean {
  return raw === undefined || raw === null
    || raw?.mode === 'keep' || raw?.kind === 'keep';
}

/**
 * The in-place edit request's shape: the statement location plus the
 * dialog-editable options for that feature, plus optional re-sourced slots —
 * a re-picked selection, profile, path, or profile/guide list. Slots the
 * request omits are re-read from the statement at apply time and preserved
 * verbatim.
 */
function validateStatementEdit(body: any): StatementEditRequest | { error: string } {
  const { feature, selectorOverride } = body ?? {};
  if (typeof feature !== 'string' || !EDITABLE_FEATURES.has(feature)) {
    return { error: 'feature must be "extrude", "sweep", "wrap", "loft", "revolve", "shell", "fillet", "chamfer", "text" or "sketch" for an edit' };
  }
  const target = validateSketchLoc(body?.edit);
  if (!target) {
    return { error: 'edit must be the {filePath, line, column} of the feature statement' };
  }
  const edit: FeatureStatementEditTarget = { line: target.line, column: target.column };
  const expected = body?.expectedStatement;
  if (expected !== undefined) {
    if (typeof expected !== 'string' || expected.length === 0 || expected.length > 4000) {
      return { error: 'expectedStatement must be the statement text from /api/feature/parse' };
    }
    edit.expectedStatement = expected;
  }
  const kind = feature as ApplyFeatureEditSpec['feature'];
  const base = { feature: kind, target, edit, needsPicks: false };

  if (feature === 'extrude') {
    // The toFace field is NOT a keep-or-absent slot: absent means the
    // distance form (dropping any target the statement had), `keep` re-emits
    // the statement's own target text, `face` re-picks it.
    const toFaceRaw = body?.toFace;
    const hasToFace = toFaceRaw !== undefined && toFaceRaw !== null;
    const options = validateExtrudeOptions(body, hasToFace);
    if ('error' in options) {
      return options;
    }
    edit.extrude = options;
    const result: StatementEditRequest = base;
    if (hasToFace) {
      if (toFaceRaw.kind === 'keep') {
        edit.extrude.toFace = { kind: 'keep' };
      } else if (toFaceRaw.kind === 'face') {
        const pick = validatePick(toFaceRaw.entity);
        if (!pick || pick.sub.type !== 'face') {
          return { error: 'a re-picked target must carry a {shapeId, sub:{type:"face", index}} pick' };
        }
        result.extrudeToFace = pick;
        result.needsPicks = true;
      } else {
        return { error: 'toFace must be {kind: "keep"} or {kind: "face", entity}' };
      }
    }
    if (isKeepSlot(body?.profile)) {
      return result;
    }
    const loc = validateSketchLoc(body.profile);
    if (body.profile?.mode !== 'bound' || !loc) {
      return { error: 'an edited profile must be {mode: "bound", filePath, line} of the sketch' };
    }
    return { ...result, extrudeProfile: loc };
  }

  if (feature === 'wrap') {
    const { op, thickness } = body ?? {};
    if (op !== 'add' && op !== 'remove' && op !== 'new') {
      return { error: 'op must be "add", "remove" or "new"' };
    }
    if (typeof thickness !== 'number' || !Number.isFinite(thickness) || thickness <= 0) {
      return { error: 'thickness must be a positive number' };
    }
    edit.wrap = { op, thickness };
    const result: StatementEditRequest = base;
    if (!isKeepSlot(body?.face)) {
      if (body.face?.kind !== 'face') {
        return { error: 'face must be {kind: "keep"} or {kind: "face", entity}' };
      }
      const pick = validatePick(body.face.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a re-picked target must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      result.wrapFace = pick;
      result.needsPicks = true;
    }
    if (isKeepSlot(body?.sketch)) {
      return result;
    }
    const loc = validateSketchLoc(body.sketch);
    if (body.sketch?.kind !== 'sketch' || !loc) {
      return { error: 'an edited wrap sketch must be {kind: "sketch", filePath, line}' };
    }
    return { ...result, wrapSketch: loc };
  }

  if (feature === 'sketch') {
    // The retarget: exactly one new target — a single face pick, an origin
    // plane, or an existing plane() feature. The body callback stays.
    edit.sketch = { target: { kind: 'selector' } };
    const plane = body?.plane;
    const planeRef = body?.planeRef;
    const entities = body?.entities;
    const hasPick = Array.isArray(entities) && entities.length > 0;
    const sources = [plane !== undefined, planeRef !== undefined, hasPick].filter(Boolean).length;
    if (sources !== 1) {
      return { error: 'a sketch retarget takes exactly one of entities, plane or planeRef' };
    }
    if (plane !== undefined) {
      if (plane !== 'xy' && plane !== 'xz' && plane !== 'yz') {
        return { error: 'plane must be "xy", "xz" or "yz"' };
      }
      return { ...base, sketchTarget: { kind: 'standard', plane } };
    }
    if (planeRef !== undefined) {
      const loc = validateSketchLoc(planeRef);
      if (!loc) {
        return { error: 'planeRef must be {filePath, line, column} of the plane feature' };
      }
      return { ...base, sketchTarget: { kind: 'planeRef', loc } };
    }
    const pick = entities.length === 1 ? validatePick(entities[0]) : null;
    if (!pick || pick.sub.type !== 'face') {
      return { error: 'a sketch retarget takes a single {shapeId, sub:{type:"face", index}} pick' };
    }
    return { ...base, sketchTarget: { kind: 'face', pick }, needsPicks: true };
  }

  if (feature === 'revolve') {
    const { op, angle } = body ?? {};
    if (op !== 'add' && op !== 'remove' && op !== 'new') {
      return { error: 'op must be "add", "remove" or "new"' };
    }
    if (!isNonzeroNumber(angle)) {
      return { error: 'angle must be a nonzero sweep angle in degrees' };
    }
    const thin = validateThinOffsets(body?.thin);
    if ('error' in thin) {
      return thin;
    }
    edit.revolve = { op, angle, thin: thin.offsets };
    const result: StatementEditRequest = base;
    if (!isKeepSlot(body?.axis)) {
      const axis = validateRevolveAxis(body.axis);
      if ('error' in axis) {
        return axis;
      }
      result.revolveAxis = axis;
      result.needsPicks ||= axis.kind === 'edge';
    }
    if (isKeepSlot(body?.profile)) {
      return result;
    }
    const loc = validateSketchLoc(body.profile);
    if (body.profile?.mode !== 'bound' || !loc) {
      return { error: 'an edited profile must be {mode: "bound", filePath, line} of the sketch' };
    }
    return { ...result, revolveProfile: loc };
  }

  if (feature === 'sweep' || feature === 'loft') {
    const { op } = body ?? {};
    if (op !== 'add' && op !== 'remove' && op !== 'new') {
      return { error: 'op must be "add", "remove" or "new"' };
    }
    const thin = validateThinOffsets(body?.thin);
    if ('error' in thin) {
      return thin;
    }
    if (feature === 'sweep') {
      edit.sweep = { op, thin: thin.offsets };
      const result: StatementEditRequest = base;
      if (!isKeepSlot(body?.path)) {
        if (body.path?.kind === 'sketch') {
          const loc = validateSketchLoc(body.path);
          if (!loc) {
            return { error: 'a sketch path must carry the sketch {filePath, line}' };
          }
          result.sweepPath = { kind: 'sketch', ...loc };
        } else if (body.path?.kind === 'edges') {
          const picks = validatePicks(body.path.entities);
          if (!picks) {
            return { error: `path entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` };
          }
          const chains = validateChains(body.path.chains);
          if (!chains) {
            return { error: 'path chains must be {seed, members} pick groups' };
          }
          result.sweepPath = { kind: 'edges', picks, chains };
          result.needsPicks = true;
        } else {
          return { error: 'path must be {kind: "sketch", filePath, line} or {kind: "edges", entities}' };
        }
      }
      if (!isKeepSlot(body?.profile)) {
        const loc = validateSketchLoc(body.profile);
        if (body.profile?.kind !== 'sketch' || !loc) {
          return { error: 'an edited sweep profile must be {kind: "sketch", filePath, line}' };
        }
        if (result.sweepPath?.kind === 'sketch' && result.sweepPath.line === loc.line
          && result.sweepPath.filePath === loc.filePath) {
          return { error: 'the profile and path must be different sketches' };
        }
        result.sweepProfile = loc;
      }
      return result;
    }
    const startResult = validateLoftCondition('startCondition', body?.startCondition);
    if ('error' in startResult) {
      return startResult;
    }
    const endResult = validateLoftCondition('endCondition', body?.endCondition);
    if ('error' in endResult) {
      return endResult;
    }
    edit.loft = {
      op,
      thin: thin.offsets,
      startCondition: startResult.condition ?? undefined,
      endCondition: endResult.condition ?? undefined,
    };
    const result: StatementEditRequest = base;
    if (body?.profiles !== undefined && body?.profiles !== null) {
      const parsed = validateEditLoftProfiles(body.profiles);
      if ('error' in parsed) {
        return parsed;
      }
      result.loftProfiles = parsed.profiles;
      result.needsPicks ||= parsed.profiles.some(p => p.kind === 'face');
    }
    if (body?.guides !== undefined && body?.guides !== null) {
      const parsed = validateEditLoftGuides(body.guides, result.loftProfiles);
      if ('error' in parsed) {
        return parsed;
      }
      result.loftGuides = parsed.guides;
    }
    return result;
  }

  if (feature === 'text') {
    const { text, size, font, weight, italic, align, lineSpacing, letterSpacing } = body ?? {};
    if (typeof text !== 'string' || text.trim() === '' || text.length > 4000) {
      return { error: 'text must be a non-empty string' };
    }
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      return { error: 'size must be a positive number' };
    }
    if (font !== null && (typeof font !== 'string' || font.length > 300)) {
      return { error: 'font must be a family name string or null' };
    }
    if (typeof weight !== 'number' || weight % 100 !== 0 || weight < 100 || weight > 900) {
      return { error: 'weight must be one of 100–900 in hundreds' };
    }
    if (typeof italic !== 'boolean') {
      return { error: 'italic must be a boolean' };
    }
    if (align !== 'left' && align !== 'center' && align !== 'right') {
      return { error: 'align must be "left", "center" or "right"' };
    }
    if (typeof lineSpacing !== 'number' || !Number.isFinite(lineSpacing) || lineSpacing <= 0) {
      return { error: 'lineSpacing must be a positive number' };
    }
    if (typeof letterSpacing !== 'number' || !Number.isFinite(letterSpacing)) {
      return { error: 'letterSpacing must be a number' };
    }
    edit.text = { text, size, font, weight, italic, align, lineSpacing, letterSpacing };
    return base;
  }

  // Shell / fillet / chamfer: the numeric value plus an optional edited
  // selector argument list (the expression row) or a re-picked selection;
  // shell adds its join type.
  const { value } = body ?? {};
  if (feature === 'shell') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
      return { error: 'value must be a nonzero number (negative hollows inward)' };
    }
    const join = validateShellJoinType(body?.joinType);
    if ('error' in join) {
      return join;
    }
    edit.shell = { joinType: join.joinType };
  } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { error: 'value must be a positive number' };
  }
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    return { error: 'selectorOverride must be a non-empty string (max 500 chars)' };
  }
  const result: StatementEditRequest = {
    ...base,
    value,
    rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
  };
  if (body?.entities !== undefined && body?.entities !== null) {
    const picks = validatePicks(body.entities);
    if (!picks) {
      return { error: `entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` };
    }
    const chains = validateChains(body?.chains);
    if (!chains) {
      return { error: 'chains must be {seed, members} pick groups' };
    }
    result.picks = picks;
    result.chains = chains;
    result.needsPicks = true;
  }
  return result;
}

/** The edited loft profile list: verbatim keeps, sketch refs, face picks. */
function validateEditLoftProfiles(
  raw: unknown,
): { profiles: EditLoftProfileInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_LOFT_PROFILES) {
    return { error: `profiles must be 2-${MAX_LOFT_PROFILES} ordered loft profiles` };
  }
  const profiles: EditLoftProfileInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry?.kind === 'verbatim') {
      if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0) {
        return { error: 'a kept profile must carry its statement argument index' };
      }
      const key = `verbatim:${entry.sourceIndex}`;
      if (seen.has(key)) {
        return { error: 'the same kept profile appears twice' };
      }
      seen.add(key);
      profiles.push({ kind: 'verbatim', sourceIndex: entry.sourceIndex });
    } else if (entry?.kind === 'sketch') {
      const loc = validateSketchLoc(entry);
      if (!loc) {
        return { error: 'a sketch profile must carry the sketch {filePath, line}' };
      }
      const key = `sketch:${loc.filePath}:${loc.line}`;
      if (seen.has(key)) {
        return { error: 'each profile must be a different sketch' };
      }
      seen.add(key);
      profiles.push({ kind: 'sketch', ...loc });
    } else if (entry?.kind === 'face') {
      const pick = validatePick(entry.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a face profile must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      const key = `face:${pick.shapeId}:${pick.sub.index}`;
      if (seen.has(key)) {
        return { error: 'the same face was picked twice — each profile must be different' };
      }
      seen.add(key);
      profiles.push({ kind: 'face', pick });
    } else {
      return { error: 'each profile must be {kind: "verbatim"|"sketch"|"face", …}' };
    }
  }
  return { profiles };
}

/** The edited loft guide list; a guide can't double as a sketch profile. */
function validateEditLoftGuides(
  raw: unknown,
  profiles: EditLoftProfileInput[] | undefined,
): { guides: EditLoftGuideInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > 2) {
    return { error: 'guides must be at most two guide sketches' };
  }
  const guides: EditLoftGuideInput[] = [];
  const seen = new Set<string>();
  for (const profile of profiles ?? []) {
    if (profile.kind === 'sketch') {
      seen.add(`sketch:${profile.filePath}:${profile.line}`);
    }
  }
  for (const entry of raw) {
    if (entry?.kind === 'verbatim') {
      if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0) {
        return { error: 'a kept guide must carry its statement argument index' };
      }
      const key = `verbatim-guide:${entry.sourceIndex}`;
      if (seen.has(key)) {
        return { error: 'the same kept guide appears twice' };
      }
      seen.add(key);
      guides.push({ kind: 'verbatim', sourceIndex: entry.sourceIndex });
    } else if (entry?.kind === 'sketch') {
      const loc = validateSketchLoc(entry);
      if (!loc) {
        return { error: 'a guide must carry the sketch {filePath, line}' };
      }
      const key = `sketch:${loc.filePath}:${loc.line}`;
      if (seen.has(key)) {
        return { error: 'a sketch cannot be both a profile and a guide' };
      }
      seen.add(key);
      guides.push({ kind: 'sketch', ...loc });
    } else {
      return { error: 'each guide must be {kind: "verbatim"|"sketch", …}' };
    }
  }
  return { guides };
}

/** Tangent chains: `{seed, members}` groups; absent/empty is fine. */
function validateChains(chains: unknown): { seed: Pick; members: Pick[] }[] | null {
  if (chains === undefined || chains === null) {
    return [];
  }
  if (!Array.isArray(chains) || chains.length > MAX_ENTITIES) {
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

export function createApplyFeatureRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => void,
): Router {
  const router = Router();

  // Read-only attribution report against the last rendered scene. Backs the
  // pick tooltips/debugging; never touches code.
  router.post('/selection/explain', (req, res) => {
    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: `entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` });
      return;
    }
    const before = validateBoundary(req.body?.before);
    if (before === null) {
      res.status(400).json({ error: 'before must be {index, type, line, column}' });
      return;
    }
    try {
      const result = fluidCadServer.explainSelection(picks, before);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Synthesize the selector expressions for the picked edges and relay the
  // edit spec to the editor extension, which owns the live buffer.
  // `preview: true` runs synthesis only (backs the expression field);
  // `selectorOverride` replaces the argument list with user-edited text.
  router.post('/apply-feature', async (req, res) => {
    const { feature, value, preview, selectorOverride } = req.body ?? {};

    // In-place statement edit (timeline double-click → edit dialog): the
    // statement at the location is re-parsed from the live buffer and its
    // dialog options replaced. Re-sourced slots (re-picked selections,
    // profiles, paths) synthesize selectors against the scene truncated to
    // the `before` boundary — the world the statement's arguments see.
    if (req.body?.edit !== undefined && req.body?.edit !== null) {
      const request = validateStatementEdit(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      const before = validateBoundary(req.body?.before);
      if (before === null) {
        res.status(400).json({ error: 'before must be {index, type, line, column}' });
        return;
      }
      // The sketch retarget is the exception: its pick was made against the
      // CURRENT full render (sketch editing merely suspended, no rollback),
      // so synthesis runs boundary-less against that same scene.
      if (request.needsPicks && !before && request.feature !== 'sketch') {
        res.status(400).json({ error: 'before is required when an edit re-picks geometry' });
        return;
      }
      try {
        // The transform edits the live buffer's file only.
        const currentFile = fluidCadServer.getCurrentFileName();
        if (currentFile && normalizePath(request.target.filePath) !== normalizePath(currentFile)) {
          res.status(422).json({ success: false, reason: 'that feature lives in a different file than the one being edited' });
          return;
        }
        const sketchLocs: SketchLoc[] = [
          ...(request.extrudeProfile ? [request.extrudeProfile] : []),
          ...(request.sweepPath?.kind === 'sketch' ? [request.sweepPath] : []),
          ...(request.sweepProfile ? [request.sweepProfile] : []),
          ...(request.wrapSketch ? [request.wrapSketch] : []),
          ...(request.revolveProfile ? [request.revolveProfile] : []),
          ...(request.revolveAxis?.kind === 'axis' ? [request.revolveAxis.loc] : []),
          ...(request.loftProfiles ?? []).filter((p): p is { kind: 'sketch' } & SketchLoc => p.kind === 'sketch'),
          ...(request.loftGuides ?? []).filter((g): g is { kind: 'sketch' } & SketchLoc => g.kind === 'sketch'),
          ...(request.sketchTarget?.kind === 'planeRef' ? [request.sketchTarget.loc] : []),
        ];
        for (const loc of sketchLocs) {
          if (normalizePath(loc.filePath) !== normalizePath(request.target.filePath)) {
            res.status(422).json({ success: false, reason: 'a re-sourced sketch lives in a different file than the edited statement' });
            return;
          }
        }

        const code = fluidCadServer.getCurrentCode();
        const { producers, merge: mergeProducer } = makeProducerMerger();
        const parts: ApplyFeatureEditSpec['parts'] = [];
        const importSet = new Set<string>();
        let synthesizedArgs: string | undefined;
        let alternatives: string[] = [];
        let rawArgs = request.rawArgs;

        let synthOptions: {
          namer?: Awaited<ReturnType<typeof makeProducerNamer>>;
          params?: { name: string; value: number }[];
        } | undefined;
        if (request.needsPicks && code) {
          synthOptions = {
            namer: await makeProducerNamer(code),
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          };
        }

        /** Synthesize one re-picked slot against the pre-statement scene. */
        const synthesizeSlot = (
          picks: Pick[],
          kind: 'extrude' | 'sweep' | 'loft' | 'revolve' | 'fillet' | 'chamfer' | 'shell' | 'wrap' | 'sketch',
          value: number | undefined,
          chains: { seed: Pick; members: Pick[] }[],
        ): any | null => {
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            picks, kind, value, chains, synthOptions, before,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return null;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return null;
          }
          return synthesis;
        };
        /** Fold one synthesis result's producers/parts/imports into the spec. */
        const foldSynthesis = (synthesis: any): number => {
          const remap = synthesis.spec.producers.map(mergeProducer);
          for (const part of synthesis.spec.parts) {
            parts.push({ ...part, producer: part.producer === null ? null : remap[part.producer] });
          }
          for (const symbol of synthesis.spec.imports) {
            importSet.add(symbol);
          }
          return parts.length - synthesis.spec.parts.length;
        };
        const sketchRef = (loc: SketchLoc, nameHint: string): number => mergeProducer({
          line: loc.line, column: loc.column, featureType: 'sketch', nameHint, bind: true,
        });

        const edit = request.edit;
        if (request.extrudeProfile) {
          edit.extrude!.profile = { kind: 'sketch', producer: sketchRef(request.extrudeProfile, 's') };
        }
        if (request.extrudeToFace) {
          const synthesis = synthesizeSlot([request.extrudeToFace], 'extrude', undefined, []);
          if (!synthesis) {
            return;
          }
          // The target argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the extrude target must be a single face selection' });
            return;
          }
          foldSynthesis(synthesis);
          edit.extrude!.toFace = { kind: 'selector' };
        }
        if (request.sweepPath) {
          if (request.sweepPath.kind === 'sketch') {
            edit.sweep!.path = { kind: 'sketch', producer: sketchRef(request.sweepPath, 'p') };
          } else {
            const synthesis = synthesizeSlot(
              request.sweepPath.picks, 'sweep', undefined, request.sweepPath.chains,
            );
            if (!synthesis) {
              return;
            }
            // The path argument is ONE SceneObject — a multi-part selection
            // has no single-expression rendering.
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({
                success: false,
                reason: 'the picked edges must form a single selection — use "Select with tangents" or pick edges of one feature',
              });
              return;
            }
            foldSynthesis(synthesis);
            edit.sweep!.path = { kind: 'selector' };
          }
        }
        if (request.sweepProfile) {
          edit.sweep!.profile = { kind: 'sketch', producer: sketchRef(request.sweepProfile, 's') };
        }
        if (request.wrapSketch) {
          edit.wrap!.sketch = { kind: 'sketch', producer: sketchRef(request.wrapSketch, 's') };
        }
        if (request.wrapFace) {
          const synthesis = synthesizeSlot([request.wrapFace], 'wrap', undefined, []);
          if (!synthesis) {
            return;
          }
          // The target argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the wrap target must be a single face selection' });
            return;
          }
          foldSynthesis(synthesis);
          edit.wrap!.face = { kind: 'selector' };
        }
        if (request.revolveProfile) {
          edit.revolve!.profile = { kind: 'sketch', producer: sketchRef(request.revolveProfile, 's') };
        }
        if (request.revolveAxis) {
          if (request.revolveAxis.kind === 'standard') {
            edit.revolve!.axis = { kind: 'standard', axis: request.revolveAxis.axis };
          } else if (request.revolveAxis.kind === 'axis') {
            edit.revolve!.axis = {
              kind: 'axis',
              producer: mergeProducer({
                line: request.revolveAxis.loc.line, column: request.revolveAxis.loc.column,
                featureType: 'axis', nameHint: 'a', bind: true,
              }),
            };
          } else {
            const synthesis = synthesizeSlot([request.revolveAxis.pick], 'revolve', undefined, []);
            if (!synthesis) {
              return;
            }
            // The axis argument is ONE SceneObject — a multi-part selection
            // has no single-expression rendering.
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({ success: false, reason: 'the revolve axis must be a single edge selection' });
              return;
            }
            foldSynthesis(synthesis);
            importSet.add('axis');
            edit.revolve!.axis = { kind: 'selector' };
          }
        }
        if (request.loftProfiles) {
          const profiles: NonNullable<FeatureStatementEditTarget['loft']>['profiles'] = [];
          for (const profile of request.loftProfiles) {
            if (profile.kind === 'verbatim') {
              profiles.push({ kind: 'verbatim', sourceIndex: profile.sourceIndex });
              continue;
            }
            if (profile.kind === 'sketch') {
              profiles.push({ kind: 'sketch', producer: sketchRef(profile, 's') });
              continue;
            }
            // Face picks synthesize ONE AT A TIME — the kernel groups picks
            // by (producer, bucket), and a batched call would merge
            // same-bucket faces into one part, destroying order and arity.
            const synthesis = synthesizeSlot([profile.pick], 'loft', undefined, []);
            if (!synthesis) {
              return;
            }
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({ success: false, reason: 'a loft profile must be a single face selection' });
              return;
            }
            const firstPart = foldSynthesis(synthesis);
            profiles.push({ kind: 'selector', part: firstPart });
          }
          edit.loft!.profiles = profiles;
        }
        if (request.loftGuides) {
          edit.loft!.guides = request.loftGuides.map(guide => guide.kind === 'verbatim'
            ? { kind: 'verbatim' as const, sourceIndex: guide.sourceIndex }
            : { kind: 'sketch' as const, producer: sketchRef(guide, 'g') });
        }
        if (request.sketchTarget) {
          const target = request.sketchTarget;
          if (target.kind === 'standard') {
            edit.sketch!.target = { kind: 'standard', plane: target.plane };
          } else if (target.kind === 'planeRef') {
            edit.sketch!.target = {
              kind: 'plane',
              producer: mergeProducer({
                line: target.loc.line, column: target.loc.column,
                featureType: 'plane', nameHint: 'p', bind: true,
              }),
            };
          } else {
            const synthesis = synthesizeSlot([target.pick], 'sketch', undefined, []);
            if (!synthesis) {
              return;
            }
            // The target argument is ONE SceneObject — a multi-part selection
            // has no single-expression rendering.
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({ success: false, reason: 'the sketch target must be a single face selection' });
              return;
            }
            foldSynthesis(synthesis);
            edit.sketch!.target = { kind: 'selector' };
          }
        }
        if (request.picks) {
          const synthesis = synthesizeSlot(
            request.picks,
            request.feature as 'fillet' | 'chamfer' | 'shell',
            request.value,
            request.chains ?? [],
          );
          if (!synthesis) {
            return;
          }
          foldSynthesis(synthesis);
          synthesizedArgs = synthesis.args;
          alternatives = synthesis.alternatives;
          // The user's expression text wins only when it differs from what
          // the picks synthesize — the create path's contract.
          rawArgs = rawArgs !== undefined && rawArgs !== synthesis.args ? rawArgs : undefined;
        }

        const spec: ApplyFeatureEditSpec = {
          feature: request.feature,
          value: request.value,
          rawArgs,
          filePath: request.target.filePath,
          producers,
          parts,
          imports: [...importSet],
          edit,
          // Applying an edit clears the breakpoint the double-click placed —
          // inside the same transform, so it can't race the rewrite — and the
          // model rebuilds to its tip. The sketch retarget opens without a
          // double-click, so it has no breakpoint to clear (and must not
          // strip ones the user placed).
          clearBreakpoints: request.feature !== 'sketch',
        };
        // Truthful preview: parse the live buffer and render the exact
        // statement the transform will write, with the same variable names
        // the transform's binding walk allocates. Refusals (a reshaped
        // statement, a stale expectedStatement, a bad source list) surface
        // here, before any edit is sent.
        let statement: string | undefined;
        if (code) {
          const parsed = await parseFeatureStatement(code, request.edit.line);
          if (parsed.ok === false) {
            res.status(422).json({ success: false, reason: parsed.reason });
            return;
          }
          if (edit.expectedStatement !== undefined && parsed.statement !== edit.expectedStatement) {
            res.status(422).json({
              success: false,
              reason: 'the statement changed since the dialog opened — re-open it to edit the current code',
            });
            return;
          }
          const vars = await allocateProducerVars(spec.producers, code);
          const rendered = renderEditedStatement(parsed.parsed, spec, i => vars[i] ?? null);
          if ('error' in rendered) {
            res.status(422).json({ success: false, reason: rendered.error });
            return;
          }
          statement = rendered.statement;
        }
        if (preview === true) {
          res.json({
            success: true,
            preview: statement,
            args: synthesizedArgs,
            alternatives: alternatives.length > 0 ? alternatives : undefined,
          });
          return;
        }
        sendToExtension({ type: 'apply-feature-edit', spec });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Extrude's profile is a sketch statement, never a pick selection — the
    // transform re-verifies that the line holds a sketch() call. The optional
    // up-to-face target IS a pick: it synthesizes a face selector rendered as
    // the call's first argument, in place of the distance(s).
    if (feature === 'extrude') {
      const request = validateExtrude(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        // The profile stays producers[0] in both modes — the transform's
        // extrude contract; the face selector's producers follow it.
        const producers: ApplyFeatureEditSpec['producers'] = [{
          line: request.profile.line,
          column: request.profile.column,
          featureType: 'sketch',
          nameHint: 's',
          bind: request.profile.mode === 'bound',
        }];
        let parts: ApplyFeatureEditSpec['parts'] = [];
        let imports: string[] = [];
        let faceArgs: string | null = null;

        if (request.toFace) {
          const synthOptions = code
            ? {
              namer: await makeProducerNamer(code),
              params: resolveParamValues(
                await extractNumericParams(code),
                fluidCadServer.getParamDefinitions(),
              ),
            }
            : undefined;
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            [request.toFace], 'extrude', undefined, [], synthOptions,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          // The target argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the extrude target must be a single face selection' });
            return;
          }
          if (synthesis.spec.filePath !== request.profile.filePath) {
            res.status(422).json({ success: false, reason: 'the target face and the profile sketch come from different files' });
            return;
          }
          parts = synthesis.spec.parts.map((part: ApplyFeatureEditSpec['parts'][number]) => ({
            ...part, producer: part.producer === null ? null : part.producer + producers.length,
          }));
          producers.push(...synthesis.spec.producers);
          imports = synthesis.spec.imports;
          faceArgs = synthesis.args;
        }

        const options: ExtrudeEditOptions = {
          op: request.op,
          distance: request.distance,
          distance2: request.distance2,
          symmetric: request.symmetric,
          draft: request.draft,
          drill: request.drill,
          thin: request.thin,
          profile: request.profile.mode === 'bound' ? 'bound' : 'implicit',
          toFace: request.toFace !== undefined,
        };
        // Truthful preview name for a bound profile: the same resolution the
        // transform runs (reused const, collision-suffixed hint).
        let profileVar: string | null = null;
        if (request.profile.mode === 'bound' && code) {
          const namer = await makeProducerNamer(code);
          profileVar = namer([{ line: request.profile.line, nameHint: 's', featureType: 'sketch' }])[0];
        }
        const statement = renderExtrudeStatement(options, profileVar, faceArgs);
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'extrude',
            extrude: options,
            filePath: request.profile.filePath,
            producers,
            parts,
            imports,
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Sweep composes a profile sketch with a path (a second sketch, or edge
    // picks synthesized into a selector) — no shared pick validation applies.
    if (feature === 'sweep') {
      const request = validateSweep(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        const producers: ApplyFeatureEditSpec['producers'] = [];
        let parts: ApplyFeatureEditSpec['parts'] = [];
        let imports: string[] = [];
        let pathArgs: string | null = null;
        let alternatives: string[] | undefined;

        if (request.path.kind === 'edges') {
          const options = code
            ? {
              namer: await makeProducerNamer(code),
              params: resolveParamValues(
                await extractNumericParams(code),
                fluidCadServer.getParamDefinitions(),
              ),
            }
            : undefined;
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            request.path.picks, 'sweep', undefined, request.path.chains, options,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          // The path argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({
              success: false,
              reason: 'the picked edges must form a single selection — use "Select with tangents" or pick edges of one feature',
            });
            return;
          }
          if (synthesis.spec.filePath !== request.profile.filePath) {
            res.status(422).json({ success: false, reason: 'the path edges and the profile sketch come from different files' });
            return;
          }
          producers.push(...synthesis.spec.producers);
          parts = synthesis.spec.parts;
          imports = synthesis.spec.imports;
          pathArgs = synthesis.args;
          alternatives = synthesis.alternatives;
        }

        let path: SweepEditOptions['path'];
        if (request.path.kind === 'sketch') {
          producers.push({
            line: request.path.line, column: request.path.column,
            featureType: 'sketch', nameHint: 'p', bind: true,
          });
          path = { kind: 'sketch', producer: producers.length - 1 };
        } else {
          path = { kind: 'selector' };
        }
        // The profile rides the producer list in both modes: bound entries
        // get a variable, the implicit anchor verifies the sketch call and
        // (with a sketch path) locates the insertion scope.
        producers.push({
          line: request.profile.line, column: request.profile.column,
          featureType: 'sketch', nameHint: 's', bind: request.profile.mode === 'bound',
        });
        const profile: SweepEditOptions['profile'] = request.profile.mode === 'bound'
          ? { producer: producers.length - 1 }
          : 'implicit';

        // Truthful preview names for the sketch inputs — one namer pass so
        // collision suffixes stay consistent across both.
        let pathVar: string | null = null;
        let profileVar: string | null = null;
        if (code) {
          const namer = await makeProducerNamer(code);
          const queries: { line: number; nameHint: string; featureType?: string }[] = [];
          if (request.path.kind === 'sketch') {
            queries.push({ line: request.path.line, nameHint: 'p', featureType: 'sketch' });
          }
          if (request.profile.mode === 'bound') {
            queries.push({ line: request.profile.line, nameHint: 's', featureType: 'sketch' });
          }
          const names = queries.length > 0 ? namer(queries) : [];
          let next = 0;
          if (request.path.kind === 'sketch') {
            pathVar = names[next++];
          }
          if (request.profile.mode === 'bound') {
            profileVar = names[next++];
          }
        }

        const options: SweepEditOptions = { op: request.op, thin: request.thin, profile, path };
        const pathExpr = request.path.kind === 'edges' ? pathArgs! : (pathVar ?? 'p');
        const statement = renderSweepStatement(
          options, pathExpr, request.profile.mode === 'bound' ? profileVar ?? 's' : null,
        );
        if (preview === true) {
          res.json({ success: true, preview: statement, args: pathArgs ?? undefined, alternatives });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'sweep',
            sweep: options,
            filePath: request.profile.filePath,
            producers,
            parts,
            imports,
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Wrap composes a sketch with a picked target face (synthesized into a
    // face selector). The sketch is always bound to a variable — wrap() takes
    // it as an explicit argument, never consuming the active sketch.
    if (feature === 'wrap') {
      const request = validateWrap(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        // The sketch stays producers[0] — the wrap transform's contract; the
        // face selector's producers follow it.
        const producers: ApplyFeatureEditSpec['producers'] = [{
          line: request.sketch.line,
          column: request.sketch.column,
          featureType: 'sketch',
          nameHint: 's',
          bind: true,
        }];
        const synthOptions = code
          ? {
            namer: await makeProducerNamer(code),
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          }
          : undefined;
        const synthesis = fluidCadServer.synthesizeApplyFeature(
          [request.face], 'wrap', undefined, [], synthOptions,
        );
        if (!synthesis) {
          res.status(404).json({ success: false, reason: 'No rendered scene' });
          return;
        }
        if (!synthesis.ok) {
          res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
          return;
        }
        // The target argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'the wrap target must be a single face selection' });
          return;
        }
        if (synthesis.spec.filePath !== request.sketch.filePath) {
          res.status(422).json({ success: false, reason: 'the target face and the sketch come from different files' });
          return;
        }
        const parts = synthesis.spec.parts.map((part: ApplyFeatureEditSpec['parts'][number]) => ({
          ...part, producer: part.producer === null ? null : part.producer + producers.length,
        }));
        producers.push(...synthesis.spec.producers);
        const imports = synthesis.spec.imports;
        const faceArgs = synthesis.args;

        const options: WrapEditOptions = {
          op: request.op,
          thickness: request.thickness,
          sketch: { producer: 0 },
        };
        // Truthful preview name for the sketch: the same resolution the
        // transform runs (reused const, collision-suffixed hint).
        let sketchVar: string | null = null;
        if (code) {
          const namer = await makeProducerNamer(code);
          sketchVar = namer([{ line: request.sketch.line, nameHint: 's', featureType: 'sketch' }])[0];
        }
        const statement = renderWrapStatement(options, sketchVar ?? 's', faceArgs);
        if (preview === true) {
          res.json({ success: true, preview: statement, args: faceArgs ?? undefined, alternatives: synthesis.alternatives });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'wrap',
            wrap: options,
            filePath: request.sketch.filePath,
            producers,
            parts,
            imports,
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Revolve composes a profile sketch around an axis — a standard world
    // axis, an existing axis statement bound to a variable, or a picked edge
    // synthesized into `axis(<selector>)`.
    if (feature === 'revolve') {
      const request = validateRevolve(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        // The profile stays producers[0] in both modes — the transform's
        // revolve contract; the axis producer / selector producers follow it.
        const producers: ApplyFeatureEditSpec['producers'] = [{
          line: request.profile.line,
          column: request.profile.column,
          featureType: 'sketch',
          nameHint: 's',
          bind: request.profile.mode === 'bound',
        }];
        let parts: ApplyFeatureEditSpec['parts'] = [];
        let imports: string[] = [];
        let axis: RevolveEditOptions['axis'];
        let axisArgs: string | null = null;
        let alternatives: string[] | undefined;

        if (request.axis.kind === 'edge') {
          const options = code
            ? {
              namer: await makeProducerNamer(code),
              params: resolveParamValues(
                await extractNumericParams(code),
                fluidCadServer.getParamDefinitions(),
              ),
            }
            : undefined;
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            [request.axis.pick], 'revolve', undefined, [], options,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          // The axis argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the revolve axis must be a single edge selection' });
            return;
          }
          if (synthesis.spec.filePath !== request.profile.filePath) {
            res.status(422).json({ success: false, reason: 'the axis edge and the profile sketch come from different files' });
            return;
          }
          parts = synthesis.spec.parts.map((part: ApplyFeatureEditSpec['parts'][number]) => ({
            ...part, producer: part.producer === null ? null : part.producer + producers.length,
          }));
          producers.push(...synthesis.spec.producers);
          imports = [...synthesis.spec.imports, 'axis'];
          axisArgs = synthesis.args;
          alternatives = synthesis.alternatives;
          axis = { kind: 'selector' };
        } else if (request.axis.kind === 'axis') {
          producers.push({
            line: request.axis.loc.line, column: request.axis.loc.column,
            featureType: 'axis', nameHint: 'a', bind: true,
          });
          axis = { kind: 'axis', producer: producers.length - 1 };
        } else {
          axis = { kind: 'standard', axis: request.axis.axis };
        }

        const options: RevolveEditOptions = {
          op: request.op,
          angle: request.angle,
          thin: request.thin,
          profile: request.profile.mode === 'bound' ? 'bound' : 'implicit',
          axis,
        };

        // Truthful preview names for the axis/profile inputs — one namer
        // pass so collision suffixes stay consistent across both.
        let axisVar: string | null = null;
        let profileVar: string | null = null;
        if (code) {
          const namer = await makeProducerNamer(code);
          const queries: { line: number; nameHint: string; featureType?: string }[] = [];
          if (request.axis.kind === 'axis') {
            queries.push({ line: request.axis.loc.line, nameHint: 'a', featureType: 'axis' });
          }
          if (request.profile.mode === 'bound') {
            queries.push({ line: request.profile.line, nameHint: 's', featureType: 'sketch' });
          }
          const names = queries.length > 0 ? namer(queries) : [];
          let next = 0;
          if (request.axis.kind === 'axis') {
            axisVar = names[next++];
          }
          if (request.profile.mode === 'bound') {
            profileVar = names[next++];
          }
        }

        const axisExpr = axis.kind === 'selector'
          ? `axis(${axisArgs})`
          : axis.kind === 'axis' ? (axisVar ?? 'a') : `'${axis.axis}'`;
        const statement = renderRevolveStatement(
          options, axisExpr, request.profile.mode === 'bound' ? profileVar ?? 's' : null,
        );
        if (preview === true) {
          res.json({ success: true, preview: statement, args: axisArgs ?? undefined, alternatives });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'revolve',
            revolve: options,
            filePath: request.profile.filePath,
            producers,
            parts,
            imports,
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Loft takes an ordered list of profiles — sketches and picked faces
    // mixed freely. Face picks run synthesis ONE AT A TIME: the kernel groups
    // picks by (producer, bucket), so a batched call would merge same-bucket
    // faces into one part and destroy profile order and arity.
    if (feature === 'loft') {
      const request = validateLoft(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        // Built on the first face profile — an all-sketch loft never runs
        // synthesis. Only `params` is passed: a namer would only shape
        // synthesis's own preview strings, which this branch discards
        // (profiles are re-rendered from the parts below).
        let synthOptions: { params: { name: string; value: number }[] } | undefined;
        let synthOptionsReady = false;

        const { producers, merge: mergeProducer } = makeProducerMerger();
        const parts: ApplyFeatureEditSpec['parts'] = [];
        const imports = new Set<string>();
        const profiles: LoftEditOptions['profiles'] = [];
        let filePath: string | null = null;

        for (const profile of request.profiles) {
          if (profile.kind === 'sketch') {
            // validateLoft holds sketches to one file; this catches a sketch
            // following a face pick synthesized from a different file.
            if (filePath !== null && profile.filePath !== filePath) {
              res.status(422).json({ success: false, reason: 'the loft profiles come from features in different files' });
              return;
            }
            filePath = profile.filePath;
            profiles.push({
              kind: 'sketch',
              producer: mergeProducer({
                line: profile.line, column: profile.column,
                featureType: 'sketch', nameHint: 's', bind: true,
              }),
            });
            continue;
          }
          if (!synthOptionsReady) {
            synthOptionsReady = true;
            if (code) {
              synthOptions = {
                params: resolveParamValues(
                  await extractNumericParams(code),
                  fluidCadServer.getParamDefinitions(),
                ),
              };
            }
          }
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            [profile.pick], 'loft', undefined, [], synthOptions,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'a loft profile must be a single face selection' });
            return;
          }
          if (filePath !== null && synthesis.spec.filePath !== filePath) {
            res.status(422).json({ success: false, reason: 'the loft profiles come from features in different files' });
            return;
          }
          filePath = synthesis.spec.filePath;
          const remap = synthesis.spec.producers.map(mergeProducer);
          const part = synthesis.spec.parts[0];
          parts.push({ ...part, producer: part.producer === null ? null : remap[part.producer] });
          for (const symbol of synthesis.spec.imports) {
            imports.add(symbol);
          }
          profiles.push({ kind: 'selector', part: parts.length - 1 });
        }

        // Guides are bound sketch producers like sketch profiles, merged the
        // same way (a sketch can't double as profile and guide — validateLoft
        // rejected that — but the merge keeps the invariant local).
        const guides: NonNullable<LoftEditOptions['guides']> = [];
        for (const guide of request.guides) {
          if (filePath !== null && guide.filePath !== filePath) {
            res.status(422).json({ success: false, reason: 'the loft guides come from features in different files' });
            return;
          }
          filePath = guide.filePath;
          guides.push({
            kind: 'sketch',
            producer: mergeProducer({
              line: guide.line, column: guide.column,
              featureType: 'sketch', nameHint: 'g', bind: true,
            }),
          });
        }

        const producerVars = await allocateProducerVars(producers, code);

        const profileExprs = profiles.map(profile => {
          if (profile.kind === 'sketch') {
            return producerVars[profile.producer] ?? 's';
          }
          const part = parts[profile.part];
          return renderSelectorPartExpr(part, part.producer === null ? null : producerVars[part.producer]);
        });

        const guideExprs = guides.map(guide => producerVars[guide.producer] ?? 'g');
        const options: LoftEditOptions = {
          op: request.op,
          thin: request.thin,
          profiles,
          guides: guides.length > 0 ? guides : undefined,
          startCondition: request.startCondition ?? undefined,
          endCondition: request.endCondition ?? undefined,
        };
        const statement = renderLoftStatement(options, profileExprs, guideExprs);
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'loft',
            loft: options,
            filePath: filePath!,
            producers,
            parts,
            imports: [...imports],
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Plane takes one base (offset) or two (mid) — standard planes, picked
    // faces/edges, or existing plane features, mixed freely. Picks run
    // synthesis one at a time like loft profiles, so each base keeps its own
    // selector part.
    if (feature === 'plane') {
      const request = validatePlane(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        // Built lazily on the first pick base — a standard/plane-only request
        // never runs synthesis. Only `params` is passed: synthesis's own
        // preview strings are discarded (bases re-render from the parts).
        let synthOptions: { params: { name: string; value: number }[] } | undefined;
        let synthOptionsReady = false;

        const { producers, merge: mergeProducer } = makeProducerMerger();
        const parts: ApplyFeatureEditSpec['parts'] = [];
        const imports = new Set<string>();
        const bases: PlaneEditOptions['bases'] = [];
        let filePath: string | null = null;

        for (const base of request.bases) {
          if (base.kind === 'standard') {
            bases.push({ kind: 'standard', plane: base.plane });
            continue;
          }
          if (base.kind === 'plane') {
            if (filePath !== null && base.loc.filePath !== filePath) {
              res.status(422).json({ success: false, reason: 'the plane bases come from features in different files' });
              return;
            }
            filePath = base.loc.filePath;
            bases.push({
              kind: 'plane',
              producer: mergeProducer({
                line: base.loc.line, column: base.loc.column,
                featureType: 'plane', nameHint: 'p', bind: true,
              }),
            });
            continue;
          }
          if (!synthOptionsReady) {
            synthOptionsReady = true;
            if (code) {
              synthOptions = {
                params: resolveParamValues(
                  await extractNumericParams(code),
                  fluidCadServer.getParamDefinitions(),
                ),
              };
            }
          }
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            [base.pick], 'plane', undefined, [], synthOptions,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'a plane base must be a single face or edge selection' });
            return;
          }
          if (filePath !== null && synthesis.spec.filePath !== filePath) {
            res.status(422).json({ success: false, reason: 'the plane bases come from features in different files' });
            return;
          }
          filePath = synthesis.spec.filePath;
          const remap = synthesis.spec.producers.map(mergeProducer);
          const part = synthesis.spec.parts[0];
          parts.push({ ...part, producer: part.producer === null ? null : remap[part.producer] });
          for (const symbol of synthesis.spec.imports) {
            imports.add(symbol);
          }
          bases.push({ kind: 'selector', part: parts.length - 1 });
        }

        // Standard-only bases reference no existing statement — the edit
        // still needs a file to land in.
        if (filePath === null) {
          filePath = fluidCadServer.getCurrentFileName();
          if (!filePath) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
        }

        const options: PlaneEditOptions = {
          type: request.type,
          offset: request.offset,
          rotateX: request.rotateX,
          rotateY: request.rotateY,
          rotateZ: request.rotateZ,
          position: request.position,
          bases,
        };
        const producerVars = await allocateProducerVars(producers, code);
        const statement = renderPlaneStatement(
          options, renderPlaneBaseExprs(options, parts, i => producerVars[i]),
        );
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'plane',
            plane: options,
            filePath,
            producers,
            parts,
            imports: [...imports],
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Repeat replays one or more timeline features linearly, circularly,
    // mirrored, or rotated. The targets are feature statements bound to
    // variables; every axis reuses the revolve axis inputs (a picked edge
    // synthesizes `axis(<selector>)` — one selector part per direction),
    // the mirror plane the plane-base inputs (a picked face synthesizes
    // `plane(<selector>)`).
    if (feature === 'repeat') {
      const request = validateRepeat(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        const filePath = request.targets[0].filePath;
        const { producers, merge: mergeProducer } = makeProducerMerger();
        const parts: ApplyFeatureEditSpec['parts'] = [];
        const imports = new Set<string>();

        const targets: RepeatEditOptions['targets'] = request.targets.map(loc => ({
          producer: mergeProducer({
            line: loc.line, column: loc.column,
            featureType: 'feature', nameHint: 'f', bind: true,
          }),
        }));

        // Built lazily on the first picked input — a pick-less request never
        // runs synthesis.
        let synthOptions: {
          namer?: Awaited<ReturnType<typeof makeProducerNamer>>;
          params?: { name: string; value: number }[];
        } | undefined;
        let synthOptionsReady = false;

        /**
         * Synthesize one picked input (axis edge / mirror face) into its own
         * selector part, reusing the single-selection synthesis kinds:
         * 'revolve' names one edge, 'plane' one face. Returns the part index,
         * or null after refusing with a response.
         */
        const synthesizeInput = async (pick: Pick, kind: 'revolve' | 'plane'): Promise<number | null> => {
          if (!synthOptionsReady) {
            synthOptionsReady = true;
            if (code) {
              synthOptions = {
                namer: await makeProducerNamer(code),
                params: resolveParamValues(
                  await extractNumericParams(code),
                  fluidCadServer.getParamDefinitions(),
                ),
              };
            }
          }
          const synthesis = fluidCadServer.synthesizeApplyFeature(
            [pick], kind, undefined, [], synthOptions,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return null;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return null;
          }
          // The axis/plane argument is ONE SceneObject — a multi-part
          // selection has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({
              success: false,
              reason: kind === 'plane'
                ? 'the mirror plane must be a single face selection'
                : 'a repeat axis must be a single edge selection',
            });
            return null;
          }
          if (synthesis.spec.filePath !== filePath) {
            res.status(422).json({
              success: false,
              reason: kind === 'plane'
                ? 'the mirror face and the targets come from different files'
                : 'an axis edge and the targets come from different files',
            });
            return null;
          }
          const remap = synthesis.spec.producers.map(mergeProducer);
          const part = synthesis.spec.parts[0];
          parts.push({ ...part, producer: part.producer === null ? null : remap[part.producer] });
          for (const symbol of synthesis.spec.imports) {
            imports.add(symbol);
          }
          imports.add(kind === 'plane' ? 'plane' : 'axis');
          return parts.length - 1;
        };

        /** One validated axis input as its spec form; null after refusing. */
        const axisSpec = async (input: RevolveAxisInput): Promise<RepeatAxisSpec | null> => {
          if (input.kind === 'standard') {
            return { kind: 'standard', axis: input.axis };
          }
          if (input.kind === 'axis') {
            return {
              kind: 'axis',
              producer: mergeProducer({
                line: input.loc.line, column: input.loc.column,
                featureType: 'axis', nameHint: 'a', bind: true,
              }),
            };
          }
          const part = await synthesizeInput(input.pick, 'revolve');
          return part === null ? null : { kind: 'selector', part };
        };

        let axis: RepeatEditOptions['axis'];
        let plane: RepeatEditOptions['plane'];
        let directions: RepeatEditOptions['directions'];
        if (request.kind === 'linear') {
          directions = [];
          for (const direction of request.directions!) {
            const resolved = await axisSpec(direction.axis);
            if (resolved === null) {
              return;
            }
            directions.push({ axis: resolved, count: direction.count, value: direction.value });
          }
        } else if (request.kind === 'mirror') {
          const input = request.plane!;
          if (input.kind === 'standard') {
            plane = { kind: 'standard', plane: input.plane };
          } else if (input.kind === 'plane') {
            plane = {
              kind: 'plane',
              producer: mergeProducer({
                line: input.loc.line, column: input.loc.column,
                featureType: 'plane', nameHint: 'p', bind: true,
              }),
            };
          } else {
            const part = await synthesizeInput(input.pick, 'plane');
            if (part === null) {
              return;
            }
            plane = { kind: 'selector', part };
          }
        } else {
          const resolved = await axisSpec(request.axis!);
          if (resolved === null) {
            return;
          }
          axis = resolved;
        }

        const options: RepeatEditOptions = {
          kind: request.kind,
          directions,
          spacingMode: request.spacingMode,
          axis,
          plane,
          count: request.count,
          sweep: request.sweep,
          centered: request.centered === true ? true : undefined,
          angle: request.angle,
          targets,
        };
        // Truthful preview: the same allocation walk the transform runs.
        const producerVars = await allocateProducerVars(producers, code);
        const varFor = (i: number): string | null => producerVars[i];
        const inputExprs = request.kind === 'mirror'
          ? [renderRepeatPlaneExpr(plane!, parts, varFor)]
          : request.kind === 'linear'
            ? directions!.map(d => renderRepeatAxisExpr(d.axis, parts, varFor))
            : [renderRepeatAxisExpr(axis!, parts, varFor)];
        const statement = renderRepeatStatement(
          options, inputExprs, targets.map(t => producerVars[t.producer] ?? 'f'),
        );
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({
          type: 'apply-feature-edit',
          spec: {
            feature: 'repeat',
            repeat: options,
            filePath,
            producers,
            parts,
            imports: [...imports],
          },
        });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // A pick-less sketch: no face selector — a sketch on an origin plane or
    // an existing plane() feature, appended after the file's last statement.
    // No synthesis is involved; `plane` picks an origin target
    // ('xy'/'xz'/'yz'), `planeRef` an existing plane statement by call site
    // (bound to a variable — `sketch(p, () => {})`), absent defaults to xy.
    if (feature === 'sketch' && Array.isArray(req.body?.entities) && req.body.entities.length === 0) {
      const plane = req.body?.plane;
      if (plane !== undefined && plane !== 'xy' && plane !== 'xz' && plane !== 'yz') {
        res.status(400).json({ error: 'plane must be "xy", "xz" or "yz"' });
        return;
      }
      if (req.body?.planeRef !== undefined) {
        const planeRef = validateSketchLoc(req.body.planeRef);
        if (!planeRef) {
          res.status(400).json({ error: 'planeRef must be {filePath, line, column} of the plane feature' });
          return;
        }
        if (plane !== undefined) {
          res.status(400).json({ error: 'plane and planeRef are mutually exclusive' });
          return;
        }
        try {
          const producers: ApplyFeatureEditSpec['producers'] = [{
            line: planeRef.line, column: planeRef.column,
            featureType: 'plane', nameHint: 'p', bind: true,
          }];
          const producerVars = await allocateProducerVars(producers, fluidCadServer.getCurrentCode());
          const statement = `sketch(${producerVars[0] ?? 'p'}, () => {\n\n})`;
          if (preview === true) {
            res.json({ success: true, preview: statement, args: '' });
            return;
          }
          sendToExtension({
            type: 'apply-feature-edit',
            spec: {
              feature: 'sketch', sketchOnPlane: true, filePath: planeRef.filePath,
              producers, parts: [], imports: [],
            },
          });
          res.json({ success: true, preview: statement });
        } catch (err: any) {
          res.status(500).json({ success: false, reason: err?.message ?? String(err) });
        }
        return;
      }
      const filePath = fluidCadServer.getCurrentFileName();
      if (!filePath) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      const statement = `sketch(${plane ? `'${plane}', ` : ''}() => {\n\n})`;
      if (preview === true) {
        res.json({ success: true, preview: statement, args: '' });
        return;
      }
      sendToExtension({
        type: 'apply-feature-edit',
        spec: { feature: 'sketch', sketchPlane: plane, filePath, producers: [], parts: [], imports: [] },
      });
      res.json({ success: true, preview: statement });
      return;
    }

    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: `entities must be 1-${MAX_ENTITIES} picks of {shapeId, sub:{type, index}}` });
      return;
    }
    const chains = validateChains(req.body?.chains);
    if (!chains) {
      res.status(400).json({ error: 'chains must be {seed, members} pick groups' });
      return;
    }
    if (feature !== 'fillet' && feature !== 'chamfer' && feature !== 'shell' && feature !== 'sketch') {
      res.status(400).json({ error: 'feature must be "fillet", "chamfer", "shell", "sketch", "extrude", "sweep", "wrap", "loft", "revolve", "plane" or "repeat"' });
      return;
    }
    // Per-feature numeric parameter: fillet/chamfer need a positive radius or
    // distance; shell needs a nonzero thickness (negative is the idiom —
    // shell(-2, …) hollows inward) plus its join type; sketch has no numeric
    // parameter at all.
    let shellJoin: ShellJoinKind = 'arc';
    if (feature === 'shell') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
        res.status(400).json({ error: 'value must be a nonzero number (negative hollows inward)' });
        return;
      }
      const join = validateShellJoinType(req.body?.joinType);
      if ('error' in join) {
        res.status(400).json({ error: join.error });
        return;
      }
      shellJoin = join.joinType;
    } else if (feature !== 'sketch') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        res.status(400).json({ error: 'value must be a positive number' });
        return;
      }
    }
    if (selectorOverride !== undefined
      && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
      res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
      return;
    }

    try {
      // Source-derived context from the live buffer: the namer keeps
      // previewed variable names truthful to the transform (reused const
      // names, collisions suffixed past file identifiers); params let
      // synthesized dimension constants render as the user's own variables.
      // Without a buffer, synthesis falls back to hints and bare numbers.
      const code = fluidCadServer.getCurrentCode();
      const options = code
        ? {
          namer: await makeProducerNamer(code),
          params: resolveParamValues(
            await extractNumericParams(code),
            fluidCadServer.getParamDefinitions(),
          ),
        }
        : undefined;
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        picks, feature, feature === 'sketch' ? undefined : value, chains, options,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return;
      }
      // Synthesis renders the bare statement; the shell join chain rides the
      // spec, so the preview must append it to stay truthful.
      const joinChain = feature === 'shell' ? renderShellJoinChain(shellJoin) : '';
      if (preview === true) {
        res.json({
          success: true,
          preview: synthesis.preview + joinChain,
          args: synthesis.args,
          alternatives: synthesis.alternatives,
        });
        return;
      }
      let spec: ApplyFeatureEditSpec = typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args
        ? { ...synthesis.spec, rawArgs: selectorOverride.trim() }
        : synthesis.spec;
      if (feature === 'shell') {
        spec = { ...spec, shell: { joinType: shellJoin } };
      }
      sendToExtension({ type: 'apply-feature-edit', spec });
      res.json({ success: true, preview: synthesis.preview + joinChain });
    } catch (err: any) {
      res.status(500).json({ success: false, reason: err?.message ?? String(err) });
    }
  });

  // Read the feature statement at a source line into its dialog-editable
  // options — the read half of the timeline double-click → edit-dialog round
  // trip. Read-only over the live buffer.
  router.post('/feature/parse', async (req, res) => {
    const { line, filePath } = req.body ?? {};
    if (!Number.isInteger(line) || line < 1) {
      res.status(400).json({ error: 'line must be a positive integer' });
      return;
    }
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.status(404).json({ error: 'No live code buffer' });
        return;
      }
      const currentFile = fluidCadServer.getCurrentFileName();
      if (typeof filePath === 'string' && filePath && currentFile
        && normalizePath(filePath) !== normalizePath(currentFile)) {
        res.status(422).json({ error: 'that feature lives in a different file than the one being edited' });
        return;
      }
      const result = await parseFeatureStatement(code, line);
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json({ ok: true, parsed: result.parsed, statement: result.statement });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Variable names of the sketch (or plane) statements at the given source
  // lines, for create-dialog labels ("spine — line 3"). Read-only over the
  // live buffer; lines without a bound statement resolve to null.
  router.post('/sketch-names', async (req, res) => {
    const { lines, callee } = req.body ?? {};
    const valid = Array.isArray(lines) && lines.length <= 64
      && lines.every((l: unknown) => Number.isInteger(l) && (l as number) >= 1);
    if (!valid) {
      res.status(400).json({ error: 'lines must be up to 64 positive integers' });
      return;
    }
    if (callee !== undefined && callee !== 'sketch' && callee !== 'plane' && callee !== 'axis') {
      res.status(400).json({ error: 'callee must be "sketch", "plane" or "axis"' });
      return;
    }
    const lineNumbers = lines as number[];
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.json({ names: lineNumbers.map((): null => null) });
        return;
      }
      res.json({ names: await resolveSketchNames(code, lineNumbers, callee ?? 'sketch') });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // The single-pick selection queries share a shape: validate the pick (and
  // the optional edit-mode boundary), run a read-only query against the last
  // render, surface not-ok reasons as 422.
  const selectionQueryRoute = (
    path: string,
    run: (pick: Pick, before?: SelectionBoundary) => any,
    project: (result: any) => unknown,
  ): void => {
    router.post(path, (req, res) => {
      const pick = validatePick(req.body?.entity);
      if (!pick) {
        res.status(400).json({ error: 'entity must be a {shapeId, sub:{type, index}} pick' });
        return;
      }
      const before = validateBoundary(req.body?.before);
      if (before === null) {
        res.status(400).json({ error: 'before must be {index, type, line, column}' });
        return;
      }
      try {
        const result = run(pick, before);
        if (!result) {
          res.status(404).json({ error: 'No rendered scene' });
          return;
        }
        if (result.ok === false) {
          res.status(422).json({ error: result.reason });
          return;
        }
        res.json(project(result));
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? String(err) });
      }
    });
  };

  // Current sources of the statement being edited, resolved for edit-dialog
  // seeding: sketch inputs by call site, selection inputs as entities on the
  // pre-statement solids (what a rollback to just before it displays).
  router.post('/feature/sources', (req, res) => {
    const before = validateBoundary(req.body?.before);
    if (!before) {
      res.status(400).json({ error: 'before must be {index, type, line, column}' });
      return;
    }
    try {
      const result = fluidCadServer.featureSources(before);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Expand a picked edge/face to its tangent chain on the owning solid —
  // the "Select with tangents" gesture.
  selectionQueryRoute('/selection/expand-tangents',
    (pick, before) => fluidCadServer.expandTangentChain(pick, before),
    result => ({ members: result.members }));

  // Expand a picked edge/face to its whole classified bucket — the
  // double-click gesture.
  selectionQueryRoute('/selection/expand-bucket',
    (pick, before) => fluidCadServer.expandBucket(pick, before),
    result => ({ members: result.members }));

  // Every multi-select group a pick can expand to (the right-click menu):
  // tangent chain, classified bucket, same-type and equal-measure edges.
  selectionQueryRoute('/selection/groups',
    (pick, before) => fluidCadServer.listSelectionGroups(pick, before),
    result => ({ groups: result.groups }));

  // Pure source transform: the extension sends the live buffer plus the edit
  // spec and gets the fully edited text back (same shape as /api/code/*).
  router.post('/code/apply-feature', async (req, res) => {
    const { code, spec } = req.body ?? {};
    if (typeof code !== 'string' || !spec || !Array.isArray(spec.producers) || !Array.isArray(spec.parts)) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    try {
      const result = await applyFeatureEdit(code, spec);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
