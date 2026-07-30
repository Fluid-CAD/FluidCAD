import { Router, type Response } from 'express';
import type { FluidCadServer, SelectionBoundary } from '../fluidcad-server.ts';
import { EditAckRegistry } from '../edit-acks.ts';
import {
  applyFeatureEdit, extractNumericParams, makeProducerNamer, parseFeatureStatement, renderBooleanStatement,
  parseOffsetTargetDescriptors,
  resolveEditedStatementLine,
  renderCopyStatement,
  renderEditedStatement,
  renderExtrudeStatement, renderHelixStatement, renderLoftStatement, renderPlaneBaseExprs, renderPlaneStatement,
  renderRepeatAxisExpr, renderRepeatPlaneExpr, renderRepeatStatement,
  renderRevolveStatement,
  renderSelectorPartExpr, renderShellJoinChain, renderSweepStatement, renderWrapStatement, resolveParamValues,
  resolveSketchNames, validCountValue, validValueExpr,
  renderChamferValueArgs, renderFaceTargetExpr, renderOffsetStatement, renderSlotStatement, renderTarcStatement,
  type ApplyFeatureEditSpec, type BooleanEditOptions, type BooleanKind, type ChamferEditOptions, type CopyEditOptions,
  type OffsetEditOptions, type SlotEditOptions,
  type ExtrudeEditOptions, type ExtrudeFaceTarget, type ExtrudeTargetKind, type FeatureStatementEditTarget,
  type HelixEditOptions,
  type HelixSourceSpec, type LoftEditOptions,
  type PlaneEditOptions, type RepeatAxisSpec, type RepeatEditAxis, type RepeatEditOptions,
  type RevolveEditOptions, type ShellJoinKind, type SweepEditOptions, type ValueExpr, type WrapEditOptions,
} from '../apply-feature-edit.ts';
import { normalizePath } from '../normalize-path.ts';
import { CHAIN_CALLEES } from '../segment-swap.ts';
import { findEditableCallAt, getJavaScriptParser, splitLines } from '../code-editor.ts';

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
function validateSketchPicks(entities: unknown): { shapeId: string }[] | null {
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
function validateThinOffsets(thin: unknown): { offsets: [ValueExpr] | [ValueExpr, ValueExpr] | null } | { error: string } {
  if (thin === undefined || thin === null) {
    return { offsets: null };
  }
  const valid = Array.isArray(thin) && thin.length >= 1 && thin.length <= 2
    && thin.every((t: unknown) => validValueExpr(t, { positive: true }));
  if (!valid) {
    return { error: 'thin must be one or two positive offsets or expressions' };
  }
  return { offsets: thin.length === 1 ? [thin[0]] : [thin[0], thin[1]] };
}

const NEW_VAR_NAME_RE = /^[a-zA-Z_$][\w$]*$/;

/**
 * The `newVariables` a dialog's expression fields committed (`myVar = 50`):
 * declarations to write directly before the statement. Absent/empty is fine.
 */
function validateNewVariables(
  raw: unknown,
): { newVariables: { name: string; initializer: string }[] | undefined } | { error: string } {
  if (raw === undefined || raw === null) {
    return { newVariables: undefined };
  }
  if (!Array.isArray(raw) || raw.length > 16) {
    return { error: 'newVariables must be up to 16 {name, initializer} declarations' };
  }
  const newVariables: { name: string; initializer: string }[] = [];
  for (const entry of raw as { name?: unknown; initializer?: unknown }[]) {
    if (typeof entry?.name !== 'string' || !NEW_VAR_NAME_RE.test(entry.name)
      || !validValueExpr(entry?.initializer)
      || typeof entry.initializer !== 'string' || entry.initializer.trim() === '') {
      return { error: 'each newVariables entry must be a valid {name, initializer}' };
    }
    newVariables.push({ name: entry.name, initializer: entry.initializer.trim() });
  }
  return { newVariables: newVariables.length > 0 ? newVariables : undefined };
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

/**
 * The 2D offset's two toggles, riding a create or edit request: absent fields
 * read as off, so a caller that knows nothing about them keeps the plain
 * `offset(d, …)` form. The pair is refused here rather than written into the
 * file — the kernel throws on it, since a removed original leaves the offset
 * nothing to cap to.
 */
function validateOffsetOptions(body: any): { options: OffsetEditOptions } | { error: string } {
  const removeOriginal = body?.removeOriginal ?? false;
  const close = body?.close ?? false;
  if (typeof removeOriginal !== 'boolean' || typeof close !== 'boolean') {
    return { error: 'removeOriginal and close must be booleans' };
  }
  if (removeOriginal && close) {
    return { error: 'a closed offset keeps its original profile — turn off "Remove original"' };
  }
  return { options: { removeOriginal, close } };
}

/**
 * The slot-from-edge toggle, riding a create or edit request: absent reads as
 * on (the kernel's `deleteSource` default), so a caller that knows nothing
 * about it keeps the plain `slot(g, r)` form. `close` belongs to offset only.
 */
function validateSlotOptions(body: any): { options: SlotEditOptions } | { error: string } {
  const removeOriginal = body?.removeOriginal ?? true;
  if (typeof removeOriginal !== 'boolean') {
    return { error: 'removeOriginal must be a boolean' };
  }
  if (body?.close !== undefined) {
    return { error: 'close only applies to offset' };
  }
  return { options: { removeOriginal } };
}

/**
 * The chamfer second-value slot riding a create or edit request: absent (or
 * null) reads as the equal-distance form; a value must be a positive number
 * or expression, and an angle additionally below 90° when it is a number.
 */
function validateChamferOptions(body: any): { options: ChamferEditOptions } | { error: string } {
  const { distance2, isAngle } = body ?? {};
  if (isAngle !== undefined && typeof isAngle !== 'boolean') {
    return { error: 'isAngle must be a boolean' };
  }
  if (distance2 === undefined || distance2 === null) {
    if (isAngle === true) {
      return { error: 'isAngle requires a distance2 angle value' };
    }
    return { options: { distance2: null, isAngle: false } };
  }
  if (!validValueExpr(distance2, { positive: true })) {
    return { error: 'distance2 must be a positive number or expression' };
  }
  if (isAngle === true && typeof distance2 === 'number' && distance2 >= 90) {
    return { error: 'the chamfer angle must be below 90 degrees' };
  }
  return { options: { distance2, isAngle: isAngle === true } };
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
  distance: ValueExpr | null;
  distance2: ValueExpr | null;
  symmetric: boolean;
  draft: ValueExpr | null;
  drill: boolean;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
};

/**
 * The extrude request's shape. The profile is a sketch — `active` consumes it
 * implicitly, `bound` binds it to a variable. `toFace` is the optional
 * up-to-face target, which replaces the distance(s): a picked face to
 * synthesize a selector from, or the `'first-face'` / `'last-face'` literal
 * the kernel resolves itself.
 */
type ExtrudeRequest = ExtrudeOptionSet & {
  profile: { mode: 'active' | 'bound' } & SketchLoc;
  toFace?: Pick | ExtrudeFaceTarget;
};


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
  } else if (!validValueExpr(distance, { nonzero: true })) {
    return { error: 'distance must be a nonzero number or expression (negative extrudes the other way)' };
  }
  if (distance2 !== undefined && distance2 !== null) {
    if (toFace) {
      return { error: 'a to-face extrude takes no second distance' };
    }
    if (!validValueExpr(distance2, { nonzero: true })) {
      return { error: 'distance2 must be a nonzero number or expression' };
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
  if (draft !== undefined && draft !== null && !validValueExpr(draft, { nonzero: true })) {
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
  const target = body?.toFace;
  const hasToFace = target !== undefined && target !== null;
  const options = validateExtrudeOptions(body, hasToFace);
  if ('error' in options) {
    return options;
  }
  const mode = body?.profile?.mode;
  const loc = validateSketchLoc(body?.profile);
  if ((mode !== 'active' && mode !== 'bound') || !loc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  const profile = { mode, ...loc };
  if (!hasToFace) {
    return { ...options, profile };
  }
  if (target === 'first-face' || target === 'last-face') {
    return { ...options, profile, toFace: target };
  }
  const pick = validatePick(target);
  if (!pick || pick.sub.type !== 'face') {
    return { error: 'toFace must be "first-face", "last-face" or a {shapeId, sub:{type:"face", index}} pick' };
  }
  return { ...options, profile, toFace: pick };
}

/**
 * The sweep request's shape: the profile is a sketch (like extrude); the
 * path is either another sketch or edge picks to synthesize a selector from.
 */
type SweepRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
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
      return { error: 'path entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
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
  thickness: ValueExpr;
  sketch: SketchLoc;
  face: Pick;
};

function validateWrap(body: any): WrapRequest | { error: string } {
  const { op, thickness, sketch } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (!validValueExpr(thickness, { positive: true })) {
    return { error: 'thickness must be a positive number or expression' };
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
  angle: ValueExpr;
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
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
  if (!validValueExpr(angle, { nonzero: true })) {
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

/**
 * One helix source input: the revolve axis family (a standard world axis, an
 * existing axis statement, or a picked edge → `axis(<selector>)`) plus a picked
 * cylindrical/conical face — the single selector on its own.
 */
type HelixSourceInput = RevolveAxisInput | { kind: 'face'; pick: Pick };

/**
 * The helix request: a single source (axis-family or face) and the chained
 * geometry configurators — each optional, null when the dialog left it blank
 * so the helix() API default applies. A helix is a wire, so there is no op,
 * profile, or thin mode.
 */
type HelixRequest = {
  source: HelixSourceInput;
  radius: ValueExpr | null;
  endRadius: ValueExpr | null;
  pitch: ValueExpr | null;
  turns: ValueExpr | null;
  height: ValueExpr | null;
  startOffset: ValueExpr | null;
  endOffset: ValueExpr | null;
};

/** The helix source: the revolve axis inputs plus a picked face. */
function validateHelixSource(raw: any): HelixSourceInput | { error: string } {
  if (raw?.kind === 'face') {
    const pick = validatePick(raw.entity);
    if (!pick || pick.sub.type !== 'face') {
      return { error: 'a helix face must carry a {shapeId, sub:{type:"face", index}} pick' };
    }
    return { kind: 'face', pick };
  }
  return validateRevolveAxis(raw);
}

/** An optional helix option: omitted (null/undefined) or a constrained value. */
function validateHelixOption(
  value: unknown,
  label: string,
  opts: { positive?: boolean; nonzero?: boolean } = {},
): { value: ValueExpr | null } | { error: string } {
  if (value === null || value === undefined) {
    return { value: null };
  }
  if (!validValueExpr(value, opts)) {
    const kind = opts.positive ? 'positive ' : opts.nonzero ? 'nonzero ' : '';
    return { error: `${label} must be a ${kind}number or expression` };
  }
  return { value };
}

function validateHelix(body: any): HelixRequest | { error: string } {
  const source = validateHelixSource(body?.source);
  if ('error' in source) {
    return source;
  }
  const radius = validateHelixOption(body?.radius, 'radius', { positive: true });
  if ('error' in radius) {
    return radius;
  }
  const endRadius = validateHelixOption(body?.endRadius, 'endRadius', { positive: true });
  if ('error' in endRadius) {
    return endRadius;
  }
  const pitch = validateHelixOption(body?.pitch, 'pitch', { nonzero: true });
  if ('error' in pitch) {
    return pitch;
  }
  const turns = validateHelixOption(body?.turns, 'turns', { positive: true });
  if ('error' in turns) {
    return turns;
  }
  const height = validateHelixOption(body?.height, 'height', { positive: true });
  if ('error' in height) {
    return height;
  }
  const startOffset = validateHelixOption(body?.startOffset, 'startOffset');
  if ('error' in startOffset) {
    return startOffset;
  }
  const endOffset = validateHelixOption(body?.endOffset, 'endOffset');
  if ('error' in endOffset) {
    return endOffset;
  }
  return {
    source,
    radius: radius.value,
    endRadius: endRadius.value,
    pitch: pitch.value,
    turns: turns.value,
    height: height.value,
    startOffset: startOffset.value,
    endOffset: endOffset.value,
  };
}

/** Ordered loft profile inputs: sketches and picked faces, mixed freely. */
type LoftProfileInput = ({ kind: 'sketch' } & SketchLoc) | { kind: 'face'; pick: Pick };

type LoftCondition = { type: 'normal' | 'tangent'; magnitude: ValueExpr };

type LoftRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
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
  if (!validValueExpr(magnitude, { nonzero: true })) {
    return { error: `${which} magnitude must be a nonzero number or expression` };
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
  | { kind: 'plane'; loc: SketchLoc }
  /** A helix statement as the edge form's base (its wire is the edge). */
  | { kind: 'wire'; loc: SketchLoc };

/** One base of an edited plane: keep the statement's own text, or re-source it. */
type PlaneEditBaseInput = { kind: 'verbatim'; sourceIndex: number } | PlaneBaseInput;

type PlaneValues = {
  type: 'offset' | 'mid' | 'edge';
  offset: ValueExpr | null;
  rotateX: ValueExpr | null;
  rotateY: ValueExpr | null;
  rotateZ: ValueExpr | null;
  position: ValueExpr | null;
};

type PlaneRequest = PlaneValues & {
  bases: PlaneBaseInput[];
};

/**
 * The value half of a plane request, shared by the create and edit paths: the
 * form plus its numeric options. The offset and per-axis rotations are
 * optional and belong to the offset/mid forms — the edge form's second
 * argument slot is taken by its normalized 0–1 position.
 */
function validatePlaneValues(body: any): PlaneValues | { error: string } {
  const { type } = body ?? {};
  if (type !== 'offset' && type !== 'mid' && type !== 'edge') {
    return { error: 'type must be "offset", "mid" or "edge"' };
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
    if (numbers.offset !== null || numbers.rotateX !== null || numbers.rotateY !== null || numbers.rotateZ !== null) {
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
    position: numbers.position,
  };
}

/**
 * One base of a plane: a standard origin plane, a picked face/edge, an
 * existing plane feature addressed by its source location, or — for the edge
 * form — a helix whose wire is the edge.
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
      return { error: 'a helix base is only valid for an edge plane' };
    }
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'a helix base must carry the helix {filePath, line}' };
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
  // The edge form's base is an edge source — a picked edge or a helix. A kept
  // base is checked against the parsed statement by the transform, the only
  // place its expression is known.
  if (type === 'edge' && source.kind !== 'wire' && source.kind !== 'verbatim'
    && (source.kind !== 'pick' || source.pick.sub.type !== 'edge')) {
    return { error: 'an edge plane takes a single picked edge or a helix as its base' };
  }
  return result;
}

/** The create request's shape: the plane's values plus its bases. */
function validatePlane(body: any): PlaneRequest | { error: string } {
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

/** The mirror plane of a repeat request: a standard plane, an existing plane feature, or a picked face. */
type RepeatPlaneInput =
  | { kind: 'standard'; plane: 'xy' | 'xz' | 'yz' }
  | { kind: 'plane'; loc: SketchLoc }
  | { kind: 'face'; pick: Pick };

/** One linear direction: its axis plus that direction's count and value. */
type RepeatDirectionInput = { axis: RevolveAxisInput; count: ValueExpr; value: ValueExpr };

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
  count?: ValueExpr;
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  centered?: boolean;
  angle?: ValueExpr;
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
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
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
    if (!validValueExpr(angle, { nonzero: true })) {
      return { error: 'angle must be a nonzero rotation in degrees' };
    }
    return { kind, targets: targetLocs, axis, angle };
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
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
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  return {
    kind, targets: targetLocs, axis, count,
    sweep: { mode: sweep.mode, value: sweep.value },
  };
}

/** One linear copy direction: its axis plus that direction's count and value. */
type CopyDirectionInput = { axis: RevolveAxisInput; count: ValueExpr; value: ValueExpr };

type CopyRequest = {
  kind: 'linear' | 'circular';
  /** The feature statements being copied, in argument order. */
  targets: SketchLoc[];
  /** Linear directions in axis order — each its own axis, count and value. */
  directions?: CopyDirectionInput[];
  /** Linear spacing semantics shared by every direction. */
  spacingMode?: 'offset' | 'length';
  axis?: RevolveAxisInput;
  count?: ValueExpr;
  sweep?: { mode: 'angle' | 'offset'; value: ValueExpr };
  centered?: boolean;
};

const MAX_COPY_TARGETS = 16;
const MAX_COPY_DIRECTIONS = 3;

/**
 * The copy request's shape, mirroring {@link validateRepeat} without the
 * mirror/rotate kinds: the kind, one or more target feature statements
 * addressed by their source locations, plus the kind's inputs — linear
 * directions (each an axis with its own count and value, sharing one
 * offset/length spacing mode) or a single axis for circular (a standard
 * world axis, an existing axis statement, or a picked edge), and the numeric
 * options (count with a sweep for circular).
 */
function validateCopy(body: any): CopyRequest | { error: string } {
  const { kind, targets, count, centered } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular') {
    return { error: 'kind must be "linear" or "circular"' };
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COPY_TARGETS) {
    return { error: `targets must be 1-${MAX_COPY_TARGETS} feature statements to copy` };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the copy targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  const filePath = targetLocs[0].filePath;

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} copy takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear copy carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
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
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_COPY_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_COPY_DIRECTIONS} axis directions` };
    }
    const directions: CopyDirectionInput[] = [];
    for (const entry of raw) {
      const axis = validateRevolveAxis(entry?.axis);
      if ('error' in axis) {
        return axis;
      }
      if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
        return { error: 'an axis and the targets live in different files' };
      }
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
      }
      directions.push({ axis, count: entry.count, value: entry.value });
    }
    return { kind, targets: targetLocs, directions, spacingMode, centered: centered === true };
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: 'only a linear copy takes directions' };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear copy takes a spacingMode' };
  }
  const axis = validateRevolveAxis(body?.axis);
  if ('error' in axis) {
    return axis;
  }
  if (axis.kind === 'axis' && axis.loc.filePath !== filePath) {
    return { error: 'the axis and the targets live in different files' };
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  if (body?.angle !== undefined && body?.angle !== null) {
    return { error: 'a circular copy carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular copy takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  return {
    kind, targets: targetLocs, axis, count,
    sweep: { mode: sweep.mode, value: sweep.value },
  };
}

type BooleanRequest = {
  kind: BooleanKind;
  /** The feature statements being combined, in argument order. */
  targets: SketchLoc[];
};

const MAX_BOOLEAN_TARGETS = 16;

/**
 * The boolean request's shape: the kind (fuse/subtract/common) plus the
 * target feature statements addressed by their source locations — a base
 * and a tool for subtract (exactly two, in that order), two or more for
 * fuse and common. No axes, values or picks — the whole statement is its
 * targets.
 */
function validateBoolean(body: any): BooleanRequest | { error: string } {
  const { kind, targets } = body ?? {};
  if (kind !== 'fuse' && kind !== 'subtract' && kind !== 'common') {
    return { error: 'kind must be "fuse", "subtract" or "common"' };
  }
  if (!Array.isArray(targets) || targets.length < 2 || targets.length > MAX_BOOLEAN_TARGETS) {
    return { error: `targets must be 2-${MAX_BOOLEAN_TARGETS} feature statements to combine` };
  }
  if (kind === 'subtract' && targets.length !== 2) {
    return { error: 'a subtract takes exactly a base and a tool solid' };
  }
  const targetLocs: SketchLoc[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const loc = validateSketchLoc(raw);
    if (!loc) {
      return { error: 'each target must be the {filePath, line} of a feature statement' };
    }
    if (loc.filePath !== targetLocs[0]?.filePath && targetLocs.length > 0) {
      return { error: 'the boolean targets live in different files' };
    }
    const key = `${loc.filePath}:${loc.line}`;
    if (seen.has(key)) {
      return { error: 'the same feature was picked twice — each target must be different' };
    }
    seen.add(key);
    targetLocs.push(loc);
  }
  return { kind, targets: targetLocs };
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
const EDITABLE_FEATURES = new Set(['extrude', 'sweep', 'loft', 'shell', 'fillet', 'chamfer', 'revolve', 'text', 'wrap', 'sketch', 'repeat', 'copy', 'boolean', 'helix', 'plane', 'offset', 'slot', 'project']);

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
  value?: ValueExpr;
  rawArgs?: string;
  /** Offset's toggles; always explicit on an edit (a cleared box clears the option). */
  offset?: OffsetEditOptions;
  /** Slot's toggle; always explicit on an edit (a cleared box writes `false`). */
  slot?: SlotEditOptions;
  /** Re-picked selection for shell/fillet/chamfer; absent keeps the args. */
  picks?: Pick[];
  chains?: { seed: Pick; members: Pick[] }[];
  /** Re-picked sketch edges for a 2D offset; absent keeps the args. */
  sketchPicks?: { shapeId: string }[];
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
  /** Re-sourced helix source (axis-family or face); absent keeps the statement's. */
  helixSource?: HelixSourceInput;
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
  /** Edited repeat's linear directions; keep axes stay by source position. */
  repeatDirections?: { axis: RepeatEditAxisInput; count: ValueExpr; value: ValueExpr }[];
  /** Edited repeat's axis (circular/rotate); keep stays by source position. */
  repeatAxis?: RepeatEditAxisInput;
  /** Edited repeat's mirror plane; keep stays the statement's own text. */
  repeatPlane?: { kind: 'keep' } | RepeatPlaneInput;
  /** Full replacement repeat target list; absent keeps the statement's. */
  repeatTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /** Edited copy's linear directions; keep axes stay by source position. */
  copyDirections?: { axis: RepeatEditAxisInput; count: ValueExpr; value: ValueExpr }[];
  /** Edited copy's axis (circular); keep stays by source position. */
  copyAxis?: RepeatEditAxisInput;
  /** Full replacement copy target list; absent keeps the statement's. */
  copyTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /** Full replacement boolean target list; absent keeps the statement's. */
  booleanTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /** Full replacement plane base list; absent keeps the statement's. */
  planeBases?: PlaneEditBaseInput[];
  /** True when a source payload carries picks — synthesis needs a boundary. */
  needsPicks: boolean;
};

/**
 * One axis slot of an edited repeat as the request carries it: keep the
 * statement's own axis text by position, or any create-mode axis input.
 */
type RepeatEditAxisInput = { kind: 'keep'; sourceIndex: number } | RevolveAxisInput;

/** One repeat-edit axis field: keep by position, or a create-mode axis. */
function validateRepeatEditAxis(raw: any): RepeatEditAxisInput | { error: string } {
  if (raw?.kind === 'keep') {
    if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0) {
      return { error: 'a kept axis must carry its {sourceIndex} in the statement' };
    }
    return { kind: 'keep', sourceIndex: raw.sourceIndex };
  }
  return validateRevolveAxis(raw);
}

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
    return { error: 'feature must be "extrude", "sweep", "wrap", "loft", "revolve", "helix", "plane", "shell", "fillet", "chamfer", "text", "sketch", "repeat", "copy", "boolean", "offset" or "project" for an edit' };
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
    // the statement's own target text, `face` re-picks it, and
    // `first-face`/`last-face` swap it for that literal.
    const toFaceRaw = body?.toFace;
    const hasToFace = toFaceRaw !== undefined && toFaceRaw !== null;
    const options = validateExtrudeOptions(body, hasToFace);
    if ('error' in options) {
      return options;
    }
    edit.extrude = options;
    const result: StatementEditRequest = base;
    if (hasToFace) {
      if (toFaceRaw.kind === 'keep' || toFaceRaw.kind === 'first-face' || toFaceRaw.kind === 'last-face') {
        edit.extrude.toFace = { kind: toFaceRaw.kind };
      } else if (toFaceRaw.kind === 'face') {
        const pick = validatePick(toFaceRaw.entity);
        if (!pick || pick.sub.type !== 'face') {
          return { error: 'a re-picked target must carry a {shapeId, sub:{type:"face", index}} pick' };
        }
        result.extrudeToFace = pick;
        result.needsPicks = true;
      } else {
        return { error: 'toFace must be {kind: "keep" | "first-face" | "last-face"} or {kind: "face", entity}' };
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
    if (!validValueExpr(thickness, { positive: true })) {
      return { error: 'thickness must be a positive number or expression' };
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
    if (!validValueExpr(angle, { nonzero: true })) {
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

  if (feature === 'helix') {
    const radius = validateHelixOption(body?.radius, 'radius', { positive: true });
    if ('error' in radius) {
      return radius;
    }
    const endRadius = validateHelixOption(body?.endRadius, 'endRadius', { positive: true });
    if ('error' in endRadius) {
      return endRadius;
    }
    const pitch = validateHelixOption(body?.pitch, 'pitch', { nonzero: true });
    if ('error' in pitch) {
      return pitch;
    }
    const turns = validateHelixOption(body?.turns, 'turns', { positive: true });
    if ('error' in turns) {
      return turns;
    }
    const height = validateHelixOption(body?.height, 'height', { positive: true });
    if ('error' in height) {
      return height;
    }
    const startOffset = validateHelixOption(body?.startOffset, 'startOffset');
    if ('error' in startOffset) {
      return startOffset;
    }
    const endOffset = validateHelixOption(body?.endOffset, 'endOffset');
    if ('error' in endOffset) {
      return endOffset;
    }
    edit.helix = {
      radius: radius.value,
      endRadius: endRadius.value,
      pitch: pitch.value,
      turns: turns.value,
      height: height.value,
      startOffset: startOffset.value,
      endOffset: endOffset.value,
    };
    const result: StatementEditRequest = base;
    // Absent source keeps the statement's own source text verbatim.
    if (!isKeepSlot(body?.source)) {
      const source = validateHelixSource(body.source);
      if ('error' in source) {
        return source;
      }
      result.helixSource = source;
      result.needsPicks ||= source.kind === 'edge' || source.kind === 'face';
    }
    return result;
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
            return { error: 'path entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
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

  if (feature === 'repeat') {
    return validateRepeatEdit(body, base, edit);
  }

  if (feature === 'copy') {
    return validateCopyEdit(body, base, edit);
  }

  if (feature === 'boolean') {
    return validateBooleanEdit(body, base, edit);
  }

  if (feature === 'plane') {
    return validatePlaneEdit(body, base, edit);
  }

  // Project (2D): no value slot — either an edited source argument list (the
  // expression row) or a re-picked set of 3D edges and faces; absent both,
  // the statement's own arguments stand. The picks are made against the edit
  // session's pre-statement rollback, so they synthesize boundary-scoped
  // (`before` required) like the 3D edit dialogs'.
  if (feature === 'project') {
    if (selectorOverride !== undefined
      && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
      return { error: 'selectorOverride must be a non-empty string (max 500 chars)' };
    }
    const result: StatementEditRequest = {
      ...base,
      rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
    };
    if (body?.entities !== undefined && body?.entities !== null) {
      const picks = validatePicks(body.entities);
      if (!picks) {
        return { error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
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

  // Offset (2D): the distance, both toggles, and either an edited target list
  // (the expression row) or a re-picked set of sketch edges. The 2D picks
  // carry no boundary — the double-click paused the build at the edited
  // statement, so the rendered sketch already IS the world it sees.
  if (feature === 'offset') {
    const { value } = body ?? {};
    if (!validValueExpr(value, { nonzero: true })) {
      return { error: 'value must be a nonzero number or expression' };
    }
    const offset = validateOffsetOptions(body);
    if ('error' in offset) {
      return offset;
    }
    if (selectorOverride !== undefined
      && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
      return { error: 'selectorOverride must be a non-empty string (max 500 chars)' };
    }
    const result: StatementEditRequest = {
      ...base,
      value,
      offset: offset.options,
      rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
    };
    if (body?.sketchEntities !== undefined && body?.sketchEntities !== null) {
      const picks = validateSketchPicks(body.sketchEntities);
      if (!picks) {
        return { error: 'sketchEntities must be a non-empty array of {shapeId} picks' };
      }
      result.sketchPicks = picks;
    }
    return result;
  }

  // Slot from edge (2D): the radius, the Remove-original toggle, and either
  // an edited source argument (the expression row) or a re-picked edge of the
  // source geometry. Like offset, the picks carry no boundary — the
  // double-click paused the build at the edited statement. The Draw tab
  // instead replaces the whole statement with a freshly drawn
  // from-dimensions form, carried verbatim as `drawStatement`.
  if (feature === 'slot') {
    const { value, drawStatement } = body ?? {};
    if (drawStatement !== undefined) {
      if (typeof drawStatement !== 'string' || drawStatement.trim().length === 0 || drawStatement.length > 500) {
        return { error: 'drawStatement must be a non-empty string (max 500 chars)' };
      }
      if (value !== undefined || body?.removeOriginal !== undefined
        || selectorOverride !== undefined || body?.sketchEntities !== undefined) {
        return { error: 'drawStatement replaces the whole statement — it takes no other slot fields' };
      }
      edit.slot = { drawStatement: drawStatement.trim() };
      return base;
    }
    if (!validValueExpr(value, { positive: true })) {
      return { error: 'value must be a positive number or expression' };
    }
    const slot = validateSlotOptions(body);
    if ('error' in slot) {
      return slot;
    }
    if (selectorOverride !== undefined
      && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
      return { error: 'selectorOverride must be a non-empty string (max 500 chars)' };
    }
    const result: StatementEditRequest = {
      ...base,
      value,
      slot: slot.options,
      rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
    };
    if (body?.sketchEntities !== undefined && body?.sketchEntities !== null) {
      const picks = validateSketchPicks(body.sketchEntities);
      if (!picks) {
        return { error: 'sketchEntities must be a non-empty array of {shapeId} picks' };
      }
      result.sketchPicks = picks;
    }
    return result;
  }

  // Shell / fillet / chamfer: the numeric value plus an optional edited
  // selector argument list (the expression row) or a re-picked selection;
  // shell adds its join type, chamfer its second value slot.
  const { value } = body ?? {};
  if (feature === 'shell') {
    if (!validValueExpr(value, { nonzero: true })) {
      return { error: 'value must be a nonzero number or expression (negative hollows inward)' };
    }
    const join = validateShellJoinType(body?.joinType);
    if ('error' in join) {
      return join;
    }
    edit.shell = { joinType: join.joinType };
  } else if (!validValueExpr(value, { positive: true })) {
    return { error: 'value must be a positive number or expression' };
  } else if (feature === 'chamfer') {
    const chamfer = validateChamferOptions(body);
    if ('error' in chamfer) {
      return chamfer;
    }
    // Always explicit on edits: `distance2: null` returns the statement to
    // the equal-distance form rather than keeping its own second value.
    edit.chamfer = chamfer.options;
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
      return { error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' };
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

/**
 * The repeat edit request's shape, mirroring {@link validateRepeat} with the
 * edit-only forms: axis/plane slots may be `keep` (an absent slot reads as
 * keep — the statement's own expression stays verbatim), and the optional
 * target list mixes `verbatim` keeps with re-picked feature statements; an
 * absent list keeps every statement target. Numeric options land on
 * `edit.repeat`; picked inputs ride the request for boundary synthesis.
 */
function validateRepeatEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { kind, count, centered, angle } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular' && kind !== 'mirror' && kind !== 'rotate') {
    return { error: 'kind must be "linear", "circular", "mirror" or "rotate"' };
  }
  const result: StatementEditRequest = base;
  const rp: NonNullable<FeatureStatementEditTarget['repeat']> = { kind };
  edit.repeat = rp;

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_REPEAT_TARGETS) {
      return { error: `targets must be 1-${MAX_REPEAT_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['repeatTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const raw of body.targets) {
      if (raw?.kind === 'verbatim') {
        if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(raw.sourceIndex);
        targets.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
      } else if (raw?.kind === 'feature') {
        const loc = validateSketchLoc(raw);
        if (!loc) {
          return { error: 'each re-picked target must be the {filePath, line} of a feature statement' };
        }
        const key = `${loc.filePath}:${loc.line}`;
        if (seenLocs.has(key)) {
          return { error: 'the same feature was picked twice — each target must be different' };
        }
        seenLocs.add(key);
        targets.push({ kind: 'feature', loc });
      } else {
        return { error: 'each target must be {kind: "verbatim"|"feature", …}' };
      }
    }
    result.repeatTargets = targets;
  }

  if (kind === 'mirror') {
    for (const key of ['axis', 'directions', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a mirror repeat takes no ${key}` };
      }
    }
    const raw = body?.plane;
    if (raw === undefined || raw === null || raw?.kind === 'keep') {
      result.repeatPlane = { kind: 'keep' };
    } else if (raw?.kind === 'standard') {
      if (raw.plane !== 'xy' && raw.plane !== 'xz' && raw.plane !== 'yz') {
        return { error: 'a standard mirror plane must be "xy", "xz" or "yz"' };
      }
      result.repeatPlane = { kind: 'standard', plane: raw.plane };
    } else if (raw?.kind === 'plane') {
      const loc = validateSketchLoc(raw);
      if (!loc) {
        return { error: 'a plane input must carry the plane {filePath, line}' };
      }
      result.repeatPlane = { kind: 'plane', loc };
    } else if (raw?.kind === 'face') {
      const pick = validatePick(raw.entity);
      if (!pick || pick.sub.type !== 'face') {
        return { error: 'a picked mirror plane must carry a {shapeId, sub:{type:"face", index}} pick' };
      }
      result.repeatPlane = { kind: 'face', pick };
      result.needsPicks = true;
    } else {
      return { error: 'plane must be {kind: "keep"|"standard"|"plane"|"face", …}' };
    }
    return result;
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
    const directions: NonNullable<StatementEditRequest['repeatDirections']> = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      // An absent axis keeps the statement's own axis at this position.
      const axis = entry?.axis === undefined || entry?.axis === null
        ? { kind: 'keep' as const, sourceIndex: i }
        : validateRepeatEditAxis(entry.axis);
      if ('error' in axis) {
        return axis;
      }
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
      }
      result.needsPicks ||= axis.kind === 'edge';
      directions.push({ axis, count: entry.count, value: entry.value });
    }
    rp.spacingMode = spacingMode;
    rp.centered = centered === true ? true : undefined;
    result.repeatDirections = directions;
    return result;
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: 'only a linear repeat takes directions' };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear repeat takes a spacingMode' };
  }
  // An absent axis keeps the statement's own (its single axis argument).
  const axis = body?.axis === undefined || body?.axis === null
    ? { kind: 'keep' as const, sourceIndex: 0 }
    : validateRepeatEditAxis(body.axis);
  if ('error' in axis) {
    return axis;
  }
  result.needsPicks ||= axis.kind === 'edge';
  result.repeatAxis = axis;

  if (kind === 'rotate') {
    for (const key of ['count', 'sweep', 'centered'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a rotate repeat takes no ${key}` };
      }
    }
    if (!validValueExpr(angle, { nonzero: true })) {
      return { error: 'angle must be a nonzero rotation in degrees' };
    }
    rp.angle = angle;
    return result;
  }

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
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
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  rp.count = count;
  rp.sweep = { mode: sweep.mode, value: sweep.value };
  return result;
}

/**
 * The copy edit request's shape, mirroring {@link validateRepeatEdit} without
 * the mirror/rotate kinds: axis slots may be `keep` (an absent slot reads as
 * keep — the statement's own expression stays verbatim), and the optional
 * target list mixes `verbatim` keeps with re-picked feature statements; an
 * absent list keeps every statement target. Numeric options land on
 * `edit.copy`; picked inputs ride the request for boundary synthesis.
 */
function validateCopyEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { kind, count, centered } = body ?? {};
  if (kind !== 'linear' && kind !== 'circular') {
    return { error: 'kind must be "linear" or "circular"' };
  }
  const result: StatementEditRequest = base;
  const cp: NonNullable<FeatureStatementEditTarget['copy']> = { kind };
  edit.copy = cp;

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_COPY_TARGETS) {
      return { error: `targets must be 1-${MAX_COPY_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['copyTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const raw of body.targets) {
      if (raw?.kind === 'verbatim') {
        if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(raw.sourceIndex);
        targets.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
      } else if (raw?.kind === 'feature') {
        const loc = validateSketchLoc(raw);
        if (!loc) {
          return { error: 'each re-picked target must be the {filePath, line} of a feature statement' };
        }
        const key = `${loc.filePath}:${loc.line}`;
        if (seenLocs.has(key)) {
          return { error: 'the same feature was picked twice — each target must be different' };
        }
        seenLocs.add(key);
        targets.push({ kind: 'feature', loc });
      } else {
        return { error: 'each target must be {kind: "verbatim"|"feature", …}' };
      }
    }
    result.copyTargets = targets;
  }

  if (body?.plane !== undefined && body?.plane !== null) {
    return { error: `a ${kind} copy takes an axis, not a plane` };
  }

  if (kind === 'linear') {
    for (const key of ['axis', 'count', 'sweep', 'angle'] as const) {
      if (body?.[key] !== undefined && body?.[key] !== null) {
        return { error: `a linear copy carries its ${key === 'axis' ? 'axes' : 'counts and values'} in the directions` };
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
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_COPY_DIRECTIONS) {
      return { error: `directions must be 1-${MAX_COPY_DIRECTIONS} axis directions` };
    }
    const directions: NonNullable<StatementEditRequest['copyDirections']> = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      // An absent axis keeps the statement's own axis at this position.
      const axis = entry?.axis === undefined || entry?.axis === null
        ? { kind: 'keep' as const, sourceIndex: i }
        : validateRepeatEditAxis(entry.axis);
      if ('error' in axis) {
        return axis;
      }
      if (!validCountValue(entry?.count)) {
        return { error: 'each direction count must be an integer of at least 2 (the original included) or an expression' };
      }
      if (!validValueExpr(entry?.value, { nonzero: true })) {
        return { error: 'each direction value must be a nonzero number or expression' };
      }
      result.needsPicks ||= axis.kind === 'edge';
      directions.push({ axis, count: entry.count, value: entry.value });
    }
    cp.spacingMode = spacingMode;
    cp.centered = centered === true ? true : undefined;
    result.copyDirections = directions;
    return result;
  }

  if (body?.directions !== undefined && body?.directions !== null) {
    return { error: 'only a linear copy takes directions' };
  }
  if (body?.spacingMode !== undefined && body?.spacingMode !== null) {
    return { error: 'only a linear copy takes a spacingMode' };
  }
  // An absent axis keeps the statement's own (its single axis argument).
  const axis = body?.axis === undefined || body?.axis === null
    ? { kind: 'keep' as const, sourceIndex: 0 }
    : validateRepeatEditAxis(body.axis);
  if ('error' in axis) {
    return axis;
  }
  result.needsPicks ||= axis.kind === 'edge';
  result.copyAxis = axis;

  if (!validCountValue(count)) {
    return { error: 'count must be an integer of at least 2 (the original included) or an expression' };
  }
  if (body?.angle !== undefined && body?.angle !== null) {
    return { error: 'a circular copy carries its angle in the sweep field' };
  }
  if (centered === true) {
    return { error: 'a circular copy takes no centered flag' };
  }
  const sweep = body?.sweep;
  if (sweep?.mode !== 'angle' && sweep?.mode !== 'offset') {
    return { error: 'sweep mode must be "angle" or "offset"' };
  }
  if (!validValueExpr(sweep.value, { nonzero: true })) {
    return { error: 'sweep value must be a nonzero number or expression' };
  }
  cp.count = count;
  cp.sweep = { mode: sweep.mode, value: sweep.value };
  return result;
}

/**
 * The boolean edit request's shape: the kind (an edit may rewrite a fuse
 * into a subtract) plus the optional target list mixing `verbatim` keeps
 * with re-picked feature statements; an absent list keeps every statement
 * target. No axes, values or picks — `needsPicks` never flips.
 */
function validateBooleanEdit(
  body: any,
  base: StatementEditRequest,
  edit: FeatureStatementEditTarget,
): StatementEditRequest | { error: string } {
  const { kind } = body ?? {};
  if (kind !== 'fuse' && kind !== 'subtract' && kind !== 'common') {
    return { error: 'kind must be "fuse", "subtract" or "common"' };
  }
  const result: StatementEditRequest = base;
  edit.boolean = { kind };

  if (body?.targets !== undefined && body?.targets !== null) {
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_BOOLEAN_TARGETS) {
      return { error: `targets must be 1-${MAX_BOOLEAN_TARGETS} kept or re-picked features` };
    }
    const targets: NonNullable<StatementEditRequest['booleanTargets']> = [];
    const seenIndices = new Set<number>();
    const seenLocs = new Set<string>();
    for (const raw of body.targets) {
      if (raw?.kind === 'verbatim') {
        if (!Number.isInteger(raw.sourceIndex) || raw.sourceIndex < 0 || seenIndices.has(raw.sourceIndex)) {
          return { error: 'each kept target must carry a distinct {sourceIndex} into the statement' };
        }
        seenIndices.add(raw.sourceIndex);
        targets.push({ kind: 'verbatim', sourceIndex: raw.sourceIndex });
      } else if (raw?.kind === 'feature') {
        const loc = validateSketchLoc(raw);
        if (!loc) {
          return { error: 'each re-picked target must be the {filePath, line} of a feature statement' };
        }
        const key = `${loc.filePath}:${loc.line}`;
        if (seenLocs.has(key)) {
          return { error: 'the same feature was picked twice — each target must be different' };
        }
        seenLocs.add(key);
        targets.push({ kind: 'feature', loc });
      } else {
        return { error: 'each target must be {kind: "verbatim"|"feature", …}' };
      }
    }
    if (kind === 'subtract' && targets.length !== 2) {
      return { error: 'a subtract takes exactly a base and a tool solid' };
    }
    result.booleanTargets = targets;
  }
  return result;
}

/**
 * The plane edit request's shape: the form and its numeric options (the
 * dialog owns all of them, so they always ride), plus the optional base list
 * mixing `verbatim` keeps with re-sourced bases; an absent list keeps every
 * statement base. A picked base flips `needsPicks` — its selector is
 * synthesized against the pre-statement boundary.
 */
function validatePlaneEdit(
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

export type ApplyFeatureRouterOptions = {
  /**
   * Dry-run every outgoing edit spec against the server's copy of the file
   * before dispatching it to the editor (default true). Tests that relay
   * synthetic specs turn this off.
   */
  preflight?: boolean;
  /** How long to wait for the editor's transform round-trip (default 5000ms). */
  ackTimeoutMs?: number;
};

export function createApplyFeatureRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => boolean | void,
  options: ApplyFeatureRouterOptions = {},
): Router {
  const router = Router();
  const preflightEnabled = options.preflight !== false;
  const ackTimeoutMs = options.ackTimeoutMs ?? 5000;
  const editAcks = new EditAckRegistry(ackTimeoutMs);

  /**
   * Dispatch an edit spec to the editor host and answer the request with the
   * true outcome, closing the old fire-and-forget gap where a transform
   * refusal died in the editor's log while the dialog reported success. Two
   * layers: a preflight dry-runs the transform against the server's copy of
   * the file (fast, synchronous refusals — stale lines, unbindable
   * producers), then the editor's round-trip through /code/apply-feature
   * acks the real transform against the live buffer (catches drift the
   * preflight can't see). A host that never round-trips within the timeout
   * reports failure instead of silent success; a send with no host process
   * at all (standalone server, tests) keeps the legacy immediate success.
   */
  async function dispatchEditSpec(
    res: Response,
    spec: ApplyFeatureEditSpec,
    successBody: Record<string, unknown>,
  ): Promise<void> {
    if (preflightEnabled && spec.filePath === fluidCadServer.getCurrentFileName()) {
      const code = fluidCadServer.getCurrentCode();
      if (code !== null) {
        try {
          const dryRun = await applyFeatureEdit(code, spec);
          if (dryRun.error) {
            res.status(422).json({ success: false, reason: dryRun.error });
            return;
          }
        } catch {
          // A preflight crash is not a verdict — the editor round-trip decides.
        }
      }
    }
    const { editId, result } = editAcks.register();
    const delivered = sendToExtension({ type: 'apply-feature-edit', spec: { ...spec, editId } }) === true;
    if (!delivered) {
      editAcks.cancel(editId);
      res.json(successBody);
      return;
    }
    const ack = await result;
    if (ack === null) {
      res.status(504).json({
        success: false,
        reason: `the editor did not apply the edit within ${ackTimeoutMs}ms — check the editor for errors`,
      });
    } else if (ack.error) {
      res.status(422).json({ success: false, reason: ack.error });
    } else {
      res.json(successBody);
    }
  }

  // Read-only attribution report against the last rendered scene. Backs the
  // pick tooltips/debugging; never touches code.
  router.post('/selection/explain', (req, res) => {
    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' });
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

    // Declarations a dialog expression field committed (`myVar = 50`) —
    // written directly before the statement by the transform.
    const nvResult = validateNewVariables(req.body?.newVariables);
    if ('error' in nvResult) {
      res.status(400).json({ error: nvResult.error });
      return;
    }
    const newVariables = nvResult.newVariables;

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
          ...(request.helixSource?.kind === 'axis' ? [request.helixSource.loc] : []),
          ...(request.loftProfiles ?? []).filter((p): p is { kind: 'sketch' } & SketchLoc => p.kind === 'sketch'),
          ...(request.loftGuides ?? []).filter((g): g is { kind: 'sketch' } & SketchLoc => g.kind === 'sketch'),
          ...(request.sketchTarget?.kind === 'planeRef' ? [request.sketchTarget.loc] : []),
          ...(request.repeatDirections ?? []).flatMap(d => d.axis.kind === 'axis' ? [d.axis.loc] : []),
          ...(request.repeatAxis?.kind === 'axis' ? [request.repeatAxis.loc] : []),
          ...(request.repeatPlane?.kind === 'plane' ? [request.repeatPlane.loc] : []),
          ...(request.repeatTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
          ...(request.copyDirections ?? []).flatMap(d => d.axis.kind === 'axis' ? [d.axis.loc] : []),
          ...(request.copyAxis?.kind === 'axis' ? [request.copyAxis.loc] : []),
          ...(request.copyTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
          ...(request.booleanTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
          ...(request.planeBases ?? []).flatMap(b => b.kind === 'plane' || b.kind === 'wire' ? [b.loc] : []),
        ];
        for (const loc of sketchLocs) {
          if (normalizePath(loc.filePath) !== normalizePath(request.target.filePath)) {
            res.status(422).json({ success: false, reason: 'a re-sourced input lives in a different file than the edited statement' });
            return;
          }
        }

        const code = fluidCadServer.getCurrentCode();
        if (code) {
          // The 2D offset's edit pause sits ABOVE its own statement, which
          // shifts the statement down after the dialog captured its line —
          // re-locate it before the preview parse and the transform spec read
          // a stale line. Inert for the 3D edits, whose pause sits below.
          request.edit.line = await resolveEditedStatementLine(
            code, request.edit.line, request.edit.expectedStatement,
          );
        }
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
        if ((request.needsPicks || request.sketchPicks) && code) {
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
          kind: 'extrude' | 'sweep' | 'loft' | 'revolve' | 'fillet' | 'chamfer' | 'shell' | 'wrap' | 'sketch' | 'plane' | 'helix' | 'project',
          value: ValueExpr | undefined,
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
        // A wire slot (a sweep path, a loft guide) takes a sketch() or a
        // helix() statement.
        const wireRef = (loc: SketchLoc, nameHint: string): number => mergeProducer({
          line: loc.line, column: loc.column, featureType: 'wire', nameHint, bind: true,
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
            edit.sweep!.path = { kind: 'sketch', producer: wireRef(request.sweepPath, 'p') };
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
        if (request.helixSource) {
          if (request.helixSource.kind === 'standard') {
            edit.helix!.source = { kind: 'standard', axis: request.helixSource.axis };
          } else if (request.helixSource.kind === 'axis') {
            edit.helix!.source = {
              kind: 'axis',
              producer: mergeProducer({
                line: request.helixSource.loc.line, column: request.helixSource.loc.column,
                featureType: 'axis', nameHint: 'a', bind: true,
              }),
            };
          } else {
            const synthesis = synthesizeSlot([request.helixSource.pick], 'helix', undefined, []);
            if (!synthesis) {
              return;
            }
            // The source argument is ONE SceneObject — a multi-part selection
            // has no single-expression rendering.
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({ success: false, reason: 'the helix source must be a single edge or face selection' });
              return;
            }
            foldSynthesis(synthesis);
            if (request.helixSource.kind === 'edge') {
              importSet.add('axis');
            }
            edit.helix!.source = { kind: request.helixSource.kind };
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
            : { kind: 'sketch' as const, producer: wireRef(guide, 'g') });
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
            request.feature as 'fillet' | 'chamfer' | 'shell' | 'project',
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
        if (request.feature === 'repeat') {
          const rp = edit.repeat!;
          // One repeat axis input as its edit spec form; null after refusing.
          // Keeps and standard axes pass through; an axis statement binds a
          // producer; a picked edge synthesizes its own selector part against
          // the pre-statement boundary, wrapped in `axis(…)` at render time.
          const resolveAxis = (input: RepeatEditAxisInput): RepeatEditAxis | null => {
            if (input.kind === 'keep') {
              return { kind: 'keep', sourceIndex: input.sourceIndex };
            }
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
            const synthesis = synthesizeSlot([input.pick], 'revolve', undefined, []);
            if (!synthesis) {
              return null;
            }
            // The axis argument is ONE SceneObject — a multi-part selection
            // has no single-expression rendering.
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({ success: false, reason: 'a repeat axis must be a single edge selection' });
              return null;
            }
            const part = foldSynthesis(synthesis);
            importSet.add('axis');
            return { kind: 'selector', part };
          };
          if (request.repeatDirections) {
            const directions: NonNullable<typeof rp.directions> = [];
            for (const direction of request.repeatDirections) {
              const axis = resolveAxis(direction.axis);
              if (axis === null) {
                return;
              }
              directions.push({ axis, count: direction.count, value: direction.value });
            }
            rp.directions = directions;
          }
          if (request.repeatAxis) {
            const axis = resolveAxis(request.repeatAxis);
            if (axis === null) {
              return;
            }
            rp.axis = axis;
          }
          if (request.repeatPlane) {
            const input = request.repeatPlane;
            if (input.kind === 'keep') {
              rp.plane = { kind: 'keep' };
            } else if (input.kind === 'standard') {
              rp.plane = { kind: 'standard', plane: input.plane };
            } else if (input.kind === 'plane') {
              rp.plane = {
                kind: 'plane',
                producer: mergeProducer({
                  line: input.loc.line, column: input.loc.column,
                  featureType: 'plane', nameHint: 'p', bind: true,
                }),
              };
            } else {
              const synthesis = synthesizeSlot([input.pick], 'plane', undefined, []);
              if (!synthesis) {
                return;
              }
              // The plane argument is ONE SceneObject — a multi-part
              // selection has no single-expression rendering.
              if (synthesis.spec.parts.length !== 1) {
                res.status(422).json({ success: false, reason: 'the mirror plane must be a single face selection' });
                return;
              }
              const part = foldSynthesis(synthesis);
              importSet.add('plane');
              rp.plane = { kind: 'selector', part };
            }
          }
          if (request.repeatTargets) {
            rp.targets = request.repeatTargets.map(target => target.kind === 'verbatim'
              ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
              : {
                kind: 'feature' as const,
                producer: mergeProducer({
                  line: target.loc.line, column: target.loc.column,
                  featureType: 'feature', nameHint: 'f', bind: true,
                }),
              });
          }
        }
        if (request.feature === 'copy') {
          const cp = edit.copy!;
          // One copy axis input as its edit spec form; null after refusing.
          // Keeps and standard axes pass through; an axis statement binds a
          // producer; a picked edge synthesizes its own selector part against
          // the pre-statement boundary, wrapped in `axis(…)` at render time.
          const resolveAxis = (input: RepeatEditAxisInput): RepeatEditAxis | null => {
            if (input.kind === 'keep') {
              return { kind: 'keep', sourceIndex: input.sourceIndex };
            }
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
            const synthesis = synthesizeSlot([input.pick], 'revolve', undefined, []);
            if (!synthesis) {
              return null;
            }
            // The axis argument is ONE SceneObject — a multi-part selection
            // has no single-expression rendering.
            if (synthesis.spec.parts.length !== 1) {
              res.status(422).json({ success: false, reason: 'a copy axis must be a single edge selection' });
              return null;
            }
            const part = foldSynthesis(synthesis);
            importSet.add('axis');
            return { kind: 'selector', part };
          };
          if (request.copyDirections) {
            const directions: NonNullable<typeof cp.directions> = [];
            for (const direction of request.copyDirections) {
              const axis = resolveAxis(direction.axis);
              if (axis === null) {
                return;
              }
              directions.push({ axis, count: direction.count, value: direction.value });
            }
            cp.directions = directions;
          }
          if (request.copyAxis) {
            const axis = resolveAxis(request.copyAxis);
            if (axis === null) {
              return;
            }
            cp.axis = axis;
          }
          if (request.copyTargets) {
            cp.targets = request.copyTargets.map(target => target.kind === 'verbatim'
              ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
              : {
                kind: 'feature' as const,
                producer: mergeProducer({
                  line: target.loc.line, column: target.loc.column,
                  featureType: 'feature', nameHint: 'f', bind: true,
                }),
              });
          }
        }
        if (request.feature === 'plane' && request.planeBases) {
          const bases: NonNullable<NonNullable<FeatureStatementEditTarget['plane']>['bases']> = [];
          for (const input of request.planeBases) {
            if (input.kind === 'verbatim') {
              bases.push({ kind: 'verbatim', sourceIndex: input.sourceIndex });
            } else if (input.kind === 'standard') {
              bases.push({ kind: 'standard', plane: input.plane });
            } else if (input.kind === 'plane' || input.kind === 'wire') {
              bases.push({
                kind: input.kind,
                producer: mergeProducer({
                  line: input.loc.line, column: input.loc.column,
                  featureType: input.kind === 'plane' ? 'plane' : 'wire',
                  nameHint: input.kind === 'plane' ? 'p' : 'h',
                  bind: true,
                }),
              });
            } else {
              // Picks synthesize ONE AT A TIME — the kernel groups picks by
              // (producer, bucket), and a batched call would merge same-bucket
              // faces into one part, destroying the per-base arity.
              const synthesis = synthesizeSlot([input.pick], 'plane', undefined, []);
              if (!synthesis) {
                return;
              }
              // A base is ONE SceneObject — a multi-part selection has no
              // single-expression rendering.
              if (synthesis.spec.parts.length !== 1) {
                res.status(422).json({ success: false, reason: 'a plane base must be a single face or edge selection' });
                return;
              }
              bases.push({ kind: 'selector', part: foldSynthesis(synthesis) });
            }
          }
          edit.plane!.bases = bases;
        }
        if (request.sketchPicks) {
          // The 2D branch of synthesis: sketch-edge picks resolve through the
          // sketch's own edge index, so the re-picked targets render exactly
          // like the create dialog's — accessors, or an induced edge filter
          // (a slot's single source renders as its bare variable).
          const synthesis = fluidCadServer.synthesizeSketchApplyFeature(
            request.sketchPicks,
            request.feature === 'slot' ? 'slot' : 'offset',
            request.value,
            { ...synthOptions, offset: request.offset, slot: request.slot },
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason });
            return;
          }
          foldSynthesis(synthesis);
          synthesizedArgs = synthesis.args;
          alternatives = synthesis.alternatives;
          // The user's expression text wins only when it differs from what
          // the picks synthesize — the create path's contract.
          rawArgs = rawArgs !== undefined && rawArgs !== synthesis.args ? rawArgs : undefined;
        }
        if (request.feature === 'boolean' && request.booleanTargets) {
          // Every re-picked target is a bound feature producer; keeps stay
          // text-addressed by their position in the statement.
          edit.boolean!.targets = request.booleanTargets.map(target => target.kind === 'verbatim'
            ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
            : {
              kind: 'feature' as const,
              producer: mergeProducer({
                line: target.loc.line, column: target.loc.column,
                featureType: 'feature', nameHint: 'f', bind: true,
              }),
            });
        }

        const spec: ApplyFeatureEditSpec = {
          feature: request.feature,
          value: request.value,
          offset: request.offset,
          slot: request.slot,
          rawArgs,
          filePath: request.target.filePath,
          producers,
          parts,
          imports: [...importSet],
          edit,
          newVariables,
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
        await dispatchEditSpec(res, spec, { success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Extrude's profile is a sketch statement, never a pick selection — the
    // transform re-verifies that the line holds a sketch() call. The optional
    // up-to-face target replaces the distance(s) as the call's first
    // argument: a picked face synthesizes a face selector, while
    // 'first-face'/'last-face' render as that literal — no pick involved,
    // the kernel resolves the face at build time.
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
        let toFace: ExtrudeTargetKind | undefined;

        if (request.toFace === 'first-face' || request.toFace === 'last-face') {
          toFace = request.toFace;
          faceArgs = renderFaceTargetExpr(request.toFace);
        } else if (request.toFace) {
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
          toFace = 'selector';
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
          toFace,
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
        await dispatchEditSpec(res, {
          feature: 'extrude',
          extrude: options,
          filePath: request.profile.filePath,
          producers,
          parts,
          imports,
          newVariables,
        }, { success: true, preview: statement });
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
          // The path is a wire source — a sketch() or a helix() statement.
          producers.push({
            line: request.path.line, column: request.path.column,
            featureType: 'wire', nameHint: 'p', bind: true,
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
            queries.push({ line: request.path.line, nameHint: 'p', featureType: 'wire' });
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
        await dispatchEditSpec(res, {
          feature: 'sweep',
          sweep: options,
          filePath: request.profile.filePath,
          producers,
          parts,
          imports,
          newVariables,
        }, { success: true, preview: statement });
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
        await dispatchEditSpec(res, {
          feature: 'wrap',
          wrap: options,
          filePath: request.sketch.filePath,
          producers,
          parts,
          imports,
          newVariables,
        }, { success: true, preview: statement });
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
        await dispatchEditSpec(res, {
          feature: 'revolve',
          revolve: options,
          filePath: request.profile.filePath,
          producers,
          parts,
          imports,
          newVariables,
        }, { success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Helix builds a wire around an axis (a standard world axis, an existing
    // axis statement bound to a variable, or a picked edge synthesized into
    // `axis(<selector>)`) or on a cylindrical/conical face (its selector on
    // its own). It consumes no sketch, so there is no profile producer.
    if (feature === 'helix') {
      const request = validateHelix(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        const producers: ApplyFeatureEditSpec['producers'] = [];
        let parts: ApplyFeatureEditSpec['parts'] = [];
        let imports: string[] = [];
        let source: HelixSourceSpec;
        let sourceArgs: string | null = null;
        let alternatives: string[] | undefined;
        let filePath: string | null = null;

        if (request.source.kind === 'edge' || request.source.kind === 'face') {
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
            [request.source.pick], 'helix', undefined, [], options,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return;
          }
          // The source argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering. No profile precedes it, so the
          // synthesized parts and producers ride the list from index 0.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the helix source must be a single edge or face selection' });
            return;
          }
          parts = synthesis.spec.parts;
          producers.push(...synthesis.spec.producers);
          imports = request.source.kind === 'edge'
            ? [...synthesis.spec.imports, 'axis']
            : synthesis.spec.imports;
          sourceArgs = synthesis.args;
          alternatives = synthesis.alternatives;
          filePath = synthesis.spec.filePath;
          source = { kind: request.source.kind };
        } else if (request.source.kind === 'axis') {
          producers.push({
            line: request.source.loc.line, column: request.source.loc.column,
            featureType: 'axis', nameHint: 'a', bind: true,
          });
          filePath = request.source.loc.filePath;
          source = { kind: 'axis', producer: producers.length - 1 };
        } else {
          source = { kind: 'standard', axis: request.source.axis };
        }

        // A standard axis references no existing statement — the helix still
        // needs a file to land in.
        if (filePath === null) {
          filePath = fluidCadServer.getCurrentFileName();
          if (!filePath) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
        }

        const options: HelixEditOptions = {
          source,
          radius: request.radius,
          endRadius: request.endRadius,
          pitch: request.pitch,
          turns: request.turns,
          height: request.height,
          startOffset: request.startOffset,
          endOffset: request.endOffset,
        };

        // Truthful preview name for a bound axis statement — the same
        // resolution the transform runs.
        let axisVar: string | null = null;
        if (code && request.source.kind === 'axis') {
          const namer = await makeProducerNamer(code);
          axisVar = namer([{ line: request.source.loc.line, nameHint: 'a', featureType: 'axis' }])[0];
        }
        const sourceExpr = source.kind === 'edge'
          ? `axis(${sourceArgs})`
          : source.kind === 'face'
            ? sourceArgs ?? ''
            : source.kind === 'axis'
              ? (axisVar ?? 'a')
              : `'${source.axis}'`;
        const statement = renderHelixStatement(options, sourceExpr);
        if (preview === true) {
          res.json({ success: true, preview: statement, args: sourceArgs ?? undefined, alternatives });
          return;
        }
        await dispatchEditSpec(res, {
          feature: 'helix',
          helix: options,
          filePath,
          producers,
          parts,
          imports,
          newVariables,
        }, { success: true, preview: statement });
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

        // Guides are bound wire producers (a sketch() or a helix() statement),
        // merged like the sketch profiles (a sketch can't double as profile
        // and guide — validateLoft rejected that — but the merge keeps the
        // invariant local).
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
              featureType: 'wire', nameHint: 'g', bind: true,
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
        await dispatchEditSpec(res, {
          feature: 'loft',
          loft: options,
          filePath: filePath!,
          producers,
          parts,
          imports: [...imports],
          newVariables,
        }, { success: true, preview: statement });
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
          if (base.kind === 'plane' || base.kind === 'wire') {
            if (filePath !== null && base.loc.filePath !== filePath) {
              res.status(422).json({ success: false, reason: 'the plane bases come from features in different files' });
              return;
            }
            filePath = base.loc.filePath;
            bases.push(base.kind === 'plane'
              ? {
                kind: 'plane',
                producer: mergeProducer({
                  line: base.loc.line, column: base.loc.column,
                  featureType: 'plane', nameHint: 'p', bind: true,
                }),
              }
              : {
                kind: 'wire',
                producer: mergeProducer({
                  line: base.loc.line, column: base.loc.column,
                  featureType: 'wire', nameHint: 'h', bind: true,
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
        await dispatchEditSpec(res, {
          feature: 'plane',
          plane: options,
          filePath,
          producers,
          parts,
          imports: [...imports],
          newVariables,
        }, { success: true, preview: statement });
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
        await dispatchEditSpec(res, {
          feature: 'repeat',
          repeat: options,
          filePath,
          producers,
          parts,
          imports: [...imports],
          newVariables,
        }, { success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    if (feature === 'copy') {
      const request = validateCopy(req.body);
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

        const targets: CopyEditOptions['targets'] = request.targets.map(loc => ({
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
         * Synthesize one picked axis edge into its own selector part, reusing
         * the single-selection 'revolve' synthesis kind (it names one edge).
         * Returns the part index, or null after refusing with a response.
         */
        const synthesizeInput = async (pick: Pick): Promise<number | null> => {
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
            [pick], 'revolve', undefined, [], synthOptions,
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return null;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
            return null;
          }
          // The axis argument is ONE SceneObject — a multi-part selection
          // has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'a copy axis must be a single edge selection' });
            return null;
          }
          if (synthesis.spec.filePath !== filePath) {
            res.status(422).json({ success: false, reason: 'an axis edge and the targets come from different files' });
            return null;
          }
          const remap = synthesis.spec.producers.map(mergeProducer);
          const part = synthesis.spec.parts[0];
          parts.push({ ...part, producer: part.producer === null ? null : remap[part.producer] });
          for (const symbol of synthesis.spec.imports) {
            imports.add(symbol);
          }
          imports.add('axis');
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
          const part = await synthesizeInput(input.pick);
          return part === null ? null : { kind: 'selector', part };
        };

        let axis: CopyEditOptions['axis'];
        let directions: CopyEditOptions['directions'];
        if (request.kind === 'linear') {
          directions = [];
          for (const direction of request.directions!) {
            const resolved = await axisSpec(direction.axis);
            if (resolved === null) {
              return;
            }
            directions.push({ axis: resolved, count: direction.count, value: direction.value });
          }
        } else {
          const resolved = await axisSpec(request.axis!);
          if (resolved === null) {
            return;
          }
          axis = resolved;
        }

        const options: CopyEditOptions = {
          kind: request.kind,
          directions,
          spacingMode: request.spacingMode,
          axis,
          count: request.count,
          sweep: request.sweep,
          centered: request.centered === true ? true : undefined,
          targets,
        };
        // Truthful preview: the same allocation walk the transform runs.
        const producerVars = await allocateProducerVars(producers, code);
        const varFor = (i: number): string | null => producerVars[i];
        const inputExprs = request.kind === 'linear'
          ? directions!.map(d => renderRepeatAxisExpr(d.axis, parts, varFor))
          : [renderRepeatAxisExpr(axis!, parts, varFor)];
        const statement = renderCopyStatement(
          options, inputExprs, targets.map(t => producerVars[t.producer] ?? 'f'),
        );
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        await dispatchEditSpec(res, {
          feature: 'copy',
          copy: options,
          filePath,
          producers,
          parts,
          imports: [...imports],
          newVariables,
        }, { success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    if (feature === 'boolean') {
      const request = validateBoolean(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        const filePath = request.targets[0].filePath;
        const { producers, merge: mergeProducer } = makeProducerMerger();

        const options: BooleanEditOptions = {
          kind: request.kind,
          targets: request.targets.map(loc => ({
            producer: mergeProducer({
              line: loc.line, column: loc.column,
              featureType: 'feature', nameHint: 'f', bind: true,
            }),
          })),
        };
        // Truthful preview: the same allocation walk the transform runs.
        const producerVars = await allocateProducerVars(producers, code);
        const statement = renderBooleanStatement(
          options.kind, options.targets.map(t => producerVars[t.producer] ?? 'f'),
        );
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        await dispatchEditSpec(res, {
          feature: 'boolean',
          boolean: options,
          filePath,
          producers,
          parts: [],
          imports: [],
          newVariables,
        }, { success: true, preview: statement });
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
          await dispatchEditSpec(res, {
            feature: 'sketch', sketchOnPlane: true, filePath: planeRef.filePath,
            producers, parts: [], imports: [],
          }, { success: true, preview: statement });
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
      await dispatchEditSpec(
        res,
        { feature: 'sketch', sketchPlane: plane, filePath, producers: [], parts: [], imports: [] },
        { success: true, preview: statement },
      );
      return;
    }

    // Project is the hybrid branch: the picks are ordinary 3D edges and faces
    // (synthesized like a fillet's), but the statement lands inside the body
    // of the sketch named by `sketch` — `project()` reads the sketch it is
    // called from. The transform binds the producers where they already live.
    if (feature === 'project') {
      const picks = validatePicks(req.body?.entities);
      if (!picks) {
        res.status(400).json({ error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' });
        return;
      }
      const chains = validateChains(req.body?.chains);
      if (!chains) {
        res.status(400).json({ error: 'chains must be {seed, members} pick groups' });
        return;
      }
      const sketchLoc = validateSketchLoc(req.body?.sketch);
      if (!sketchLoc) {
        res.status(400).json({ error: 'sketch must be {filePath, line, column} of the sketch receiving the projection' });
        return;
      }
      if (selectorOverride !== undefined
        && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
        res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
        return;
      }
      try {
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
          picks, 'project', undefined, chains, options,
        );
        if (!synthesis) {
          res.status(404).json({ success: false, reason: 'No rendered scene' });
          return;
        }
        if (!synthesis.ok) {
          res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
          return;
        }
        // The sources and the sketch must share a file: the statement binds
        // their variables from inside the sketch body.
        if (normalizePath(synthesis.spec.filePath) !== normalizePath(sketchLoc.filePath)) {
          res.status(422).json({
            success: false,
            reason: 'the picked geometry lives in a different file than the sketch',
          });
          return;
        }
        // Composed here rather than taken from `synthesis.preview`: the args
        // ARE the statement, and composing keeps the preview identical to what
        // the transform writes even against a workspace kernel that predates
        // the project feature kind (it would render the valued form).
        const statementPreview = `project(${synthesis.args})`;
        if (preview === true) {
          res.json({
            success: true,
            preview: statementPreview,
            args: synthesis.args,
            alternatives: synthesis.alternatives,
          });
          return;
        }
        let spec: ApplyFeatureEditSpec = {
          ...synthesis.spec,
          feature: 'project',
          value: undefined,
          project: { sketch: { line: sketchLoc.line, column: sketchLoc.column } },
        };
        if (typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args) {
          spec = { ...spec, rawArgs: selectorOverride.trim() };
        }
        await dispatchEditSpec(res, spec, { success: true, preview: statementPreview });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Sketch-edge picks (2D branch): 1 shapeId = 1 sketch edge, no sub refs.
    // Synthesis resolves them through the sketch edge index and the emitted
    // statement lands inside the sketch body via the same edit-spec transform.
    if (req.body?.sketchEntities !== undefined) {
      const sketchPicks = validateSketchPicks(req.body.sketchEntities);
      if (!sketchPicks) {
        res.status(400).json({ error: 'sketchEntities must be a non-empty array of {shapeId} picks' });
        return;
      }
      if (feature !== 'fillet' && feature !== 'offset' && feature !== 'slot' && feature !== 'trim'
        && feature !== 'fuse' && feature !== 'subtract' && feature !== 'common' && feature !== 'tarc') {
        res.status(400).json({ error: 'feature must be "fillet", "offset", "slot", "trim", "fuse", "subtract", "common" or "tarc" for sketch-edge selections' });
        return;
      }
      // Trim and the booleans carry no numeric parameter.
      const sketchValueless = feature === 'trim'
        || feature === 'fuse' || feature === 'subtract' || feature === 'common';
      // Fillet and slot need a positive radius; offset allows a negative
      // distance (the inward idiom) but not zero; the booleans carry no value
      // at all.
      if ((feature === 'fillet' || feature === 'slot') && !validValueExpr(value, { positive: true })) {
        res.status(400).json({ error: 'value must be a positive number or expression' });
        return;
      }
      // tArc's signed radius allows negative (flips the sweep direction) but
      // not zero, like offset's distance.
      if ((feature === 'offset' || feature === 'tarc') && !validValueExpr(value, { nonzero: true })) {
        res.status(400).json({ error: 'value must be a nonzero number or expression' });
        return;
      }
      // Offset's dialog toggles: the `removeOriginal` argument and `.close()`.
      // Slot's single toggle: the trailing `deleteSource` argument.
      let offsetOptions: OffsetEditOptions | undefined;
      let slotOptions: SlotEditOptions | undefined;
      if (feature === 'offset') {
        const parsed = validateOffsetOptions(req.body);
        if ('error' in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        offsetOptions = parsed.options;
      } else if (feature === 'slot') {
        const parsed = validateSlotOptions(req.body);
        if ('error' in parsed) {
          res.status(400).json({ error: parsed.error });
          return;
        }
        slotOptions = parsed.options;
      } else if (req.body?.removeOriginal !== undefined || req.body?.close !== undefined) {
        res.status(400).json({ error: 'removeOriginal and close only apply to offset and slot' });
        return;
      }
      // Subtract is slot-addressed: sketchEntities is the base pick set,
      // sketchToolEntities the tool's.
      let sketchToolPicks: { shapeId: string }[] | undefined;
      if (feature === 'subtract') {
        sketchToolPicks = validateSketchPicks(req.body?.sketchToolEntities) ?? undefined;
        if (!sketchToolPicks) {
          res.status(400).json({ error: 'sketchToolEntities must be a non-empty array of {shapeId} picks for subtract' });
          return;
        }
      } else if (req.body?.sketchToolEntities !== undefined) {
        res.status(400).json({ error: 'sketchToolEntities only applies to subtract' });
        return;
      }
      if (selectorOverride !== undefined
        && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
        res.status(400).json({ error: 'selectorOverride must be a non-empty string (max 500 chars)' });
        return;
      }
      try {
        const code = fluidCadServer.getCurrentCode();
        const options = code
          ? {
            namer: await makeProducerNamer(code),
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
            toolRefs: sketchToolPicks,
            offset: offsetOptions,
            slot: slotOptions,
          }
          : { toolRefs: sketchToolPicks, offset: offsetOptions, slot: slotOptions };
        const synthesis = fluidCadServer.synthesizeSketchApplyFeature(
          sketchPicks, feature, sketchValueless ? undefined : value, options,
        );
        if (!synthesis) {
          res.status(404).json({ success: false, reason: 'No rendered scene' });
          return;
        }
        if (!synthesis.ok) {
          res.status(422).json({ success: false, reason: synthesis.reason });
          return;
        }
        // Slot's source must be a bare geometry variable — a workspace kernel
        // predating the 'slot' kind falls through its accessor synthesis and
        // returns forms SlotFromEdge cannot consume; refuse those honestly.
        if (feature === 'slot' && !/^[A-Za-z_$][\w$]*$/.test(synthesis.args)) {
          res.status(422).json({
            success: false,
            reason: "the workspace's FluidCAD version does not support slot from edge — update its fluidcad dependency",
          });
          return;
        }
        // Same rule for tArc's target: the kernel reads the object's first
        // shape, so only a bare variable works; older workspace kernels fall
        // through to accessor/filter forms tArc cannot consume.
        if (feature === 'tarc' && !/^[A-Za-z_$][\w$]*$/.test(synthesis.args)) {
          res.status(422).json({
            success: false,
            reason: "the workspace's FluidCAD version does not support tArc to an edge — update its fluidcad dependency",
          });
          return;
        }
        // The toggles are statement shape, not selection knowledge: re-attach
        // them here so a workspace kernel predating them still writes (and
        // previews) the form the dialog asked for.
        const statement = offsetOptions
          ? renderOffsetStatement(value, synthesis.args, offsetOptions)
          : feature === 'slot'
            ? renderSlotStatement(value, synthesis.args, slotOptions)
            : feature === 'tarc'
              ? renderTarcStatement(value, synthesis.args)
              : synthesis.preview;
        if (preview === true) {
          res.json({
            success: true,
            preview: statement,
            args: synthesis.args,
            alternatives: synthesis.alternatives,
          });
          return;
        }
        let spec: ApplyFeatureEditSpec = typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args
          ? { ...synthesis.spec, rawArgs: selectorOverride.trim() }
          : synthesis.spec;
        if (offsetOptions) {
          spec = { ...spec, offset: offsetOptions };
        }
        if (slotOptions) {
          spec = { ...spec, slot: slotOptions };
        }
        if (newVariables) {
          spec = { ...spec, newVariables };
        }
        await dispatchEditSpec(res, spec, { success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    const picks = validatePicks(req.body?.entities);
    if (!picks) {
      res.status(400).json({ error: 'entities must be a non-empty array of {shapeId, sub:{type, index}} picks' });
      return;
    }
    const chains = validateChains(req.body?.chains);
    if (!chains) {
      res.status(400).json({ error: 'chains must be {seed, members} pick groups' });
      return;
    }
    if (feature !== 'fillet' && feature !== 'chamfer' && feature !== 'shell' && feature !== 'sketch') {
      res.status(400).json({ error: 'feature must be "fillet", "chamfer", "shell", "sketch", "extrude", "sweep", "wrap", "loft", "revolve", "plane", "project", "repeat", "copy" or "boolean"' });
      return;
    }
    // Per-feature numeric parameter: fillet/chamfer need a positive radius or
    // distance (chamfer optionally a second distance or angle); shell needs a
    // nonzero thickness (negative is the idiom — shell(-2, …) hollows inward)
    // plus its join type; sketch has no numeric parameter at all.
    let shellJoin: ShellJoinKind = 'arc';
    let chamferOptions: ChamferEditOptions | undefined;
    if (feature === 'shell') {
      if (!validValueExpr(value, { nonzero: true })) {
        res.status(400).json({ error: 'value must be a nonzero number or expression (negative hollows inward)' });
        return;
      }
      const join = validateShellJoinType(req.body?.joinType);
      if ('error' in join) {
        res.status(400).json({ error: join.error });
        return;
      }
      shellJoin = join.joinType;
    } else if (feature !== 'sketch') {
      if (!validValueExpr(value, { positive: true })) {
        res.status(400).json({ error: 'value must be a positive number or expression' });
        return;
      }
      if (feature === 'chamfer') {
        const chamfer = validateChamferOptions(req.body);
        if ('error' in chamfer) {
          res.status(400).json({ error: chamfer.error });
          return;
        }
        chamferOptions = chamfer.options.distance2 !== null ? chamfer.options : undefined;
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
      // Synthesis renders the bare statement; the shell join chain and the
      // chamfer second value ride the spec, so the preview must fold them in
      // to stay truthful.
      const joinChain = feature === 'shell' ? renderShellJoinChain(shellJoin) : '';
      const statementPreview = chamferOptions
        ? `chamfer(${renderChamferValueArgs(value, chamferOptions)}, ${synthesis.args})`
        : synthesis.preview + joinChain;
      if (preview === true) {
        res.json({
          success: true,
          preview: statementPreview,
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
      if (chamferOptions) {
        spec = { ...spec, chamfer: chamferOptions };
      }
      if (newVariables) {
        spec = { ...spec, newVariables };
      }
      await dispatchEditSpec(res, spec, { success: true, preview: statementPreview });
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
    if (callee !== undefined && callee !== 'sketch' && callee !== 'plane' && callee !== 'axis' && callee !== 'helix') {
      res.status(400).json({ error: 'callee must be "sketch", "plane", "axis" or "helix"' });
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

  // Current target edges of the 2D offset statement being edited, resolved
  // for edit-dialog seeding. The edit's pause-before means the offset object
  // itself is absent from the paused scene, so the targets re-resolve from
  // the statement's own argument forms against the active sketch — after
  // healing the line the pause's breakpoint shifted.
  router.post('/sketch/feature-sources', async (req, res) => {
    const edit = validateSketchLoc(req.body?.edit);
    if (!edit) {
      res.status(400).json({ error: 'edit must be the {filePath, line, column} of the offset statement' });
      return;
    }
    const expected = req.body?.expectedStatement;
    if (expected !== undefined && (typeof expected !== 'string' || expected.length === 0 || expected.length > 4000)) {
      res.status(400).json({ error: 'expectedStatement must be the statement text from /api/feature/parse' });
      return;
    }
    try {
      const code = fluidCadServer.getCurrentCode();
      if (!code) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      const line = await resolveEditedStatementLine(code, edit.line, expected);
      const parsed = await parseOffsetTargetDescriptors(code, line);
      if (parsed.ok === false) {
        res.status(422).json({ error: parsed.reason });
        return;
      }
      if (parsed.descriptors.length === 0) {
        // A whole-sketch offset targets nothing nameable — nothing to seed.
        res.json({ ok: true, shapeIds: [] });
        return;
      }
      const result = fluidCadServer.resolveSketchStatementTargets(parsed.descriptors);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      res.json({ ok: true, shapeIds: result.shapeIds });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

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

  // The current chain text at a segment's source line, read from the live
  // buffer — the drift guard the convert apply verifies against. Refuses when
  // code and scene are out of sync instead of guessing.
  const readSegmentStatement = async (
    loc: { filePath: string; line: number },
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    const code = fluidCadServer.getCurrentCode();
    if (!code) {
      return { ok: false, reason: 'No live code buffer' };
    }
    const currentFile = fluidCadServer.getCurrentFileName();
    if (currentFile && normalizePath(loc.filePath) !== normalizePath(currentFile)) {
      return { ok: false, reason: 'that segment lives in a different file than the one being edited' };
    }
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const call = findEditableCallAt(tree, splitLines(code), loc.line);
    const rootCallee = call ? code.slice(call.startIndex, call.endIndex).match(/^(\w+)\s*\(/)?.[1] : undefined;
    if (!call || !rootCallee || !CHAIN_CALLEES.has(rootCallee)) {
      return { ok: false, reason: 'the code buffer is out of sync with the last render — re-render first' };
    }
    return { ok: true, text: code.slice(call.startIndex, call.endIndex) };
  };

  // Legal constrained/free conversions for a picked chained sketch segment,
  // plus the current statement text the apply will drift-guard against.
  router.post('/sketch/segment-conversions', async (req, res) => {
    const shapeId = req.body?.shapeId;
    if (typeof shapeId !== 'string' || shapeId.length === 0) {
      res.status(400).json({ error: 'shapeId must be a non-empty string' });
      return;
    }
    try {
      const result = fluidCadServer.listSegmentConversions({ shapeId });
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      const statement = await readSegmentStatement(result.sourceLocation);
      if (statement.ok === false) {
        res.status(422).json({ error: statement.reason });
        return;
      }
      res.json({
        ok: true,
        currentKind: result.currentKind,
        sourceLocation: result.sourceLocation,
        options: result.options,
        expectedStatement: statement.text,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Apply one conversion: re-run the analysis fresh (never trust a stale
  // option), verify the target is enabled and the buffer unchanged, then ride
  // the generic apply-feature-edit round trip through the extension.
  router.post('/sketch/convert-segment', async (req, res) => {
    const { shapeId, target, expectedStatement } = req.body ?? {};
    if (typeof shapeId !== 'string' || shapeId.length === 0
      || typeof target !== 'string' || typeof expectedStatement !== 'string') {
      res.status(400).json({ error: 'shapeId, target and expectedStatement are required' });
      return;
    }
    try {
      const result = fluidCadServer.listSegmentConversions({ shapeId });
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
        return;
      }
      if (result.ok === false) {
        res.status(422).json({ error: result.reason });
        return;
      }
      const option = (result.options ?? []).find((o: any) => o.target === target);
      if (!option) {
        res.status(422).json({ error: `this segment has no ${target} conversion` });
        return;
      }
      if (!option.enabled || !option.newStatement) {
        res.status(422).json({ error: option.reason ?? 'that conversion is not available for this segment' });
        return;
      }
      const statement = await readSegmentStatement(result.sourceLocation);
      if (statement.ok === false) {
        res.status(422).json({ error: statement.reason });
        return;
      }
      if (statement.text !== expectedStatement) {
        res.status(422).json({ error: 'the statement changed since the menu opened — re-open it to convert the current code' });
        return;
      }
      const spec: ApplyFeatureEditSpec = {
        feature: 'sketch',
        filePath: result.sourceLocation.filePath,
        producers: [],
        parts: [],
        imports: [],
        segmentSwap: {
          edit: { filePath: result.sourceLocation.filePath, line: result.sourceLocation.line },
          expectedStatement,
          newStatement: option.newStatement,
        },
      };
      await dispatchEditSpec(res, spec, { success: true, newStatement: option.newStatement });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  // Pure source transform: the extension sends the live buffer plus the edit
  // spec and gets the fully edited text back (same shape as /api/code/*).
  // A spec carrying an `editId` is the round-trip of a dispatchEditSpec send —
  // its outcome settles the original /apply-feature request still waiting on
  // the ack.
  router.post('/code/apply-feature', async (req, res) => {
    const { code, spec } = req.body ?? {};
    if (typeof code !== 'string' || !spec || !Array.isArray(spec.producers) || !Array.isArray(spec.parts)) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const { editId, ...editSpec } = spec;
    try {
      const result = await applyFeatureEdit(code, editSpec);
      if (typeof editId === 'string') {
        editAcks.resolve(editId, result.error);
      }
      res.json(result);
    } catch (err: any) {
      const message = err?.message || String(err);
      if (typeof editId === 'string') {
        editAcks.resolve(editId, message);
      }
      res.status(500).json({ error: message });
    }
  });

  return router;
}
