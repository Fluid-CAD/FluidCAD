import { Router } from 'express';
import { extractNumericParams, resolveParamValues } from '../apply-feature-edit.ts';
import { getJavaScriptParser, type TSNode, type TSTree } from '../code-editor.ts';
import type {
  FeatureGhostRequest, FluidCadServer, GhostAxisRef, GhostEntityRef, GhostHelixSourceRef,
  GhostPathRef, GhostPlaneBaseRef, GhostPlaneRef, GhostRepeatDirection, GhostSectionRef,
} from '../fluidcad-server.ts';
import { MAX_COPY_TARGETS, MAX_REPEAT_TARGETS } from './apply-feature.ts';

/** A dialog numeric slot on the wire: a number, or verbatim expression text. */
type ValueExpr = number | string;

/** A takeoff condition before its magnitude is resolved to a number. */
type RawCondition = { type: 'normal' | 'tangent'; magnitude: ValueExpr };

type GhostBody = {
  feature?: unknown;
  op?: unknown;
  distance?: unknown;
  distance2?: unknown;
  symmetric?: unknown;
  draft?: unknown;
  drill?: unknown;
  thin?: unknown;
  angle?: unknown;
  offset?: unknown;
  value?: unknown;
  isAngle?: unknown;
  edges?: unknown;
  axis?: { kind?: unknown; axis?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  profile?: { filePath?: unknown; line?: unknown };
  thickness?: unknown;
  parallel?: unknown;
  extend?: unknown;
  spine?: { filePath?: unknown; line?: unknown };
  scope?: unknown;
  exclude?: { filePath?: unknown; line?: unknown };
  path?: unknown;
  profiles?: unknown;
  guides?: unknown;
  startCondition?: unknown;
  endCondition?: unknown;
  source?: unknown;
  radius?: unknown;
  endRadius?: unknown;
  pitch?: unknown;
  turns?: unknown;
  height?: unknown;
  startOffset?: unknown;
  endOffset?: unknown;
  kind?: unknown;
  targets?: unknown;
  axes?: unknown;
  plane?: unknown;
  directions?: unknown;
  centered?: unknown;
  count?: unknown;
  sweep?: unknown;
  type?: unknown;
  bases?: unknown;
  rotateX?: unknown;
  rotateY?: unknown;
  rotateZ?: unknown;
  position?: unknown;
  skip?: unknown;
  close?: unknown;
  entities?: unknown;
};

const FEATURES = [
  'extrude', 'revolve', 'sweep', 'loft', 'fillet', 'chamfer', 'helix', 'repeat', 'copy', 'plane', 'rib',
  'offset',
];

/** The features that modify edges of an existing solid rather than sweep a profile. */
const BAND_FEATURES = ['fillet', 'chamfer'];

/** The features that sweep one profile — the only ones carrying a profile ref. */
const PROFILE_FEATURES = ['extrude', 'revolve', 'sweep'];

const OPS = ['add', 'remove', 'new'];

const STANDARD_AXES = ['x', 'y', 'z'];

const STANDARD_PLANES = ['xy', 'xz', 'yz'];

const CONDITION_TYPES = ['normal', 'tangent'];

const REPEAT_KINDS = ['linear', 'circular', 'mirror', 'rotate'];

/** The copy's two: it walks an axis or spins around one, and mirrors nothing. */
const COPY_KINDS = ['linear', 'circular'];

/** The plane dialog's three forms; the base count follows from the type. */
const PLANE_TYPES = ['offset', 'mid', 'edge'];

/** The circular dialog's two angle forms: the whole sweep, or one step of it. */
const SWEEP_MODES = ['angle', 'offset'];

/**
 * Two directions is what the repeat and copy dialogs write; more is
 * hand-written code.
 */
const MAX_GHOST_DIRECTIONS = 2;

/** The ceiling on a copy's skip list — the dialog's own (copy-skip.ts). */
const MAX_GHOST_SKIP = 256;

/** A bare JS identifier — the expression form that resolves without a parse. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Everything an arithmetic dimension can be made of. A cheap gate before the
 * parser: a quote, a comma, a bracket means the text is something other than
 * a sum over parameters, and nothing else here needs to look at it.
 */
const ARITHMETIC = /^[A-Za-z0-9_$.\s+\-*/%()]+$/;

/** Just enough of the shared tree-sitter parser to read one expression. */
type ExpressionParser = { parse(code: string): TSTree };

function isValueExpr(value: unknown): value is ValueExpr {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '');
}

function isValueExprOrNull(value: unknown): value is ValueExpr | null {
  return value === null || value === undefined || isValueExpr(value);
}

function isThin(value: unknown): value is [ValueExpr] | [ValueExpr, ValueExpr] | null {
  if (value === null || value === undefined) {
    return true;
  }
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(isValueExpr);
}

/**
 * The revolve axis slot, narrowed to the three forms the kernel resolves.
 * Anything else — a keep chip the client failed to resolve, a malformed pick
 * — is a bad request, not a silent fall back to a world axis.
 */
function parseAxis(value: GhostBody['axis']): GhostAxisRef | null {
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
function parseHelixSource(value: unknown): GhostHelixSourceRef | null {
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
function parsePath(value: unknown): GhostPathRef | null {
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
function parseSections(value: unknown): GhostSectionRef[] | null {
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
function parseEntityRefs(value: unknown): GhostEntityRef[] | null {
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
 * The offset dialog's picked sketch edges: one shapeId names one sketch edge,
 * no sub-shape indices (the 2D pick invariant). An EMPTY list is valid — the
 * `offset(d)` form, which offsets the whole active sketch — so only a missing
 * or malformed entry refuses.
 */
function parseSketchEntityRefs(value: unknown): { shapeId: string }[] | null {
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
function parseSourceRefs(value: unknown): { filePath: string; line: number }[] | null {
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
function parsePlane(value: unknown): GhostPlaneRef | null {
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
function parsePlaneBases(value: unknown, type: 'offset' | 'mid' | 'edge'): GhostPlaneBaseRef[] | string {
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
function parseAxes(value: unknown): GhostAxisRef[] | null {
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
type RawRepeat = {
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
function parseRepeat(body: GhostBody): RawRepeat | string {
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
type RawCopy = {
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
function parseCopy(body: GhostBody): RawCopy | string {
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

/** A takeoff condition; 'none' never travels, so absent means unconstrained. */
function parseCondition(value: unknown): RawCondition | null | 'invalid' {
  if (value === null || value === undefined) {
    return null;
  }
  const condition = value as { type?: unknown; magnitude?: unknown };
  if (typeof condition.type !== 'string' || !CONDITION_TYPES.includes(condition.type)
    || !isValueExpr(condition.magnitude)) {
    return 'invalid';
  }
  return { type: condition.type as RawCondition['type'], magnitude: condition.magnitude };
}

/**
 * Resolve a dialog value to the number the kernel needs. A number passes
 * through; a name resolves against the file's top-level numeric params,
 * exactly as apply-feature's synthesis links dimensions; and arithmetic over
 * those names is worked out here — `{ count: sides, offset: 360 / sides }` is
 * how a parametric model is actually written, and refusing it left those
 * dialogs with no ghost at all.
 *
 * Parsing goes through the server's own JavaScript grammar rather than a
 * hand-rolled one, and only arithmetic survives {@link evaluateArithmetic}: a
 * name that isn't a param, a call, anything with a side effect resolves to
 * null and the dialog simply shows no ghost.
 */
function resolveExpr(
  value: ValueExpr,
  params: Map<string, number>,
  parser: ExpressionParser,
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = value.trim();
  if (IDENTIFIER.test(text)) {
    // The common case — a bare name, no parse needed.
    const resolved = params.get(text);
    return resolved !== undefined && Number.isFinite(resolved) ? resolved : null;
  }
  if (!ARITHMETIC.test(text)) {
    return null;
  }
  const statements = parser.parse(text).rootNode.namedChildren;
  if (statements.length !== 1 || statements[0].type !== 'expression_statement') {
    return null;
  }
  const expression = statements[0].namedChild(0);
  const result = expression ? evaluateArithmetic(expression, params) : null;
  return result !== null && Number.isFinite(result) ? result : null;
}

/**
 * An arithmetic expression's value, or null the moment it stops being
 * arithmetic. Five node types survive — a number, a parameter name, a
 * parenthesized group, and the unary and binary operators — so a call, a
 * member access, an assignment resolves to nothing rather than running: this
 * reads text a dialog typed, and it must not be able to *do* anything.
 */
function evaluateArithmetic(node: TSNode, params: Map<string, number>): number | null {
  if (node.type === 'number') {
    const value = Number(node.text);
    return Number.isFinite(value) ? value : null;
  }
  if (node.type === 'identifier') {
    const value = params.get(node.text);
    return value !== undefined && Number.isFinite(value) ? value : null;
  }
  if (node.type === 'parenthesized_expression') {
    const inner = node.namedChild(0);
    return inner ? evaluateArithmetic(inner, params) : null;
  }
  if (node.type === 'unary_expression') {
    const argument = node.childForFieldName('argument');
    const value = argument ? evaluateArithmetic(argument, params) : null;
    if (value === null) {
      return null;
    }
    const operator = node.childForFieldName('operator')?.text;
    return operator === '-' ? -value : operator === '+' ? value : null;
  }
  if (node.type !== 'binary_expression') {
    return null;
  }
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const a = left ? evaluateArithmetic(left, params) : null;
  const b = right ? evaluateArithmetic(right, params) : null;
  if (a === null || b === null) {
    return null;
  }
  switch (node.childForFieldName('operator')?.text) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b === 0 ? null : a / b;
    case '%':
      return b === 0 ? null : a % b;
    case '**':
      return a ** b;
    default:
      return null;
  }
}

/**
 * Live geometry preview for the open feature dialog ("ghost"): the bodies an
 * extrude/revolve/loft/cut would sweep, meshed and returned to the requesting
 * client only. Nothing here writes code, scene state, or a broadcast — see
 * `FluidCadServer.featureGhost`.
 *
 * Its own small validator on purpose: the ghost body is a fraction of an
 * apply-feature payload, and the two must not drift into each other.
 */
export function createFeatureGhostRouter(fluidCadServer: FluidCadServer): Router {
  const router = Router();

  router.post('/feature-ghost', async (req, res) => {
    const body = (req.body ?? {}) as GhostBody;

    if (typeof body.feature !== 'string' || !FEATURES.includes(body.feature)) {
      res.status(400).json({ success: false, reason: 'Unsupported ghost feature' });
      return;
    }
    // Only the features that put material somewhere carry an op. A band's
    // direction is read off the geometry per edge rather than declared by the
    // dialog, a helix is a wire — it adds and removes nothing at all — and a
    // repeat or a copy inherits whatever its targets already do.
    const isBand = BAND_FEATURES.includes(body.feature);
    const isHelix = body.feature === 'helix';
    const isRepeat = body.feature === 'repeat';
    const isCopy = body.feature === 'copy';
    const isPlane = body.feature === 'plane';
    // A 2D offset adds curves to its sketch — there is no add/remove/new.
    const isOffset = body.feature === 'offset';
    if (!isBand && !isHelix && !isRepeat && !isCopy && !isPlane && !isOffset
      && (typeof body.op !== 'string' || !OPS.includes(body.op))) {
      res.status(400).json({ success: false, reason: 'Invalid op' });
      return;
    }
    if (!isValueExprOrNull(body.distance) || !isValueExprOrNull(body.distance2)
      || !isValueExprOrNull(body.draft) || !isValueExprOrNull(body.angle)
      || !isValueExprOrNull(body.value) || !isValueExprOrNull(body.count)
      || !isThin(body.thin)
      || !isValueExprOrNull(body.radius) || !isValueExprOrNull(body.endRadius)
      || !isValueExprOrNull(body.pitch) || !isValueExprOrNull(body.turns)
      || !isValueExprOrNull(body.height) || !isValueExprOrNull(body.startOffset)
      || !isValueExprOrNull(body.endOffset)
      || !isValueExprOrNull(body.offset) || !isValueExprOrNull(body.rotateX)
      || !isValueExprOrNull(body.rotateY) || !isValueExprOrNull(body.rotateZ)
      || !isValueExprOrNull(body.position) || !isValueExprOrNull(body.thickness)) {
      res.status(400).json({ success: false, reason: 'Invalid dimension' });
      return;
    }
    let edgeRefs: GhostEntityRef[] | null = null;
    if (isBand) {
      edgeRefs = parseEntityRefs(body.edges);
      if (!edgeRefs || edgeRefs.length === 0) {
        res.status(400).json({ success: false, reason: 'Invalid edge selection' });
        return;
      }
    }
    let sketchEntities: { shapeId: string }[] | null = null;
    if (isOffset) {
      sketchEntities = parseSketchEntityRefs(body.entities);
      if (!sketchEntities) {
        res.status(400).json({ success: false, reason: 'Invalid edge selection' });
        return;
      }
    }
    const isLoft = body.feature === 'loft';
    let profileRef: { filePath: string; line: number } | null = null;
    if (PROFILE_FEATURES.includes(body.feature)) {
      const profile = body.profile;
      if (typeof profile?.filePath !== 'string' || typeof profile?.line !== 'number') {
        res.status(400).json({ success: false, reason: 'Invalid profile reference' });
        return;
      }
      profileRef = { filePath: profile.filePath, line: profile.line };
    }
    const isRib = body.feature === 'rib';
    let spineRef: { filePath: string; line: number } | null = null;
    let ribScope: { filePath: string; line: number }[] = [];
    let ribExclude: { filePath: string; line: number } | undefined;
    if (isRib) {
      const spine = body.spine;
      if (typeof spine?.filePath !== 'string' || typeof spine?.line !== 'number') {
        res.status(400).json({ success: false, reason: 'Invalid spine reference' });
        return;
      }
      spineRef = { filePath: spine.filePath, line: spine.line };
      const scope = parseSourceRefs(body.scope ?? []);
      if (!scope || scope.length > MAX_COPY_TARGETS) {
        res.status(400).json({ success: false, reason: 'Invalid scope references' });
        return;
      }
      ribScope = scope;
      if (body.exclude !== undefined && body.exclude !== null) {
        if (typeof body.exclude.filePath !== 'string' || typeof body.exclude.line !== 'number') {
          res.status(400).json({ success: false, reason: 'Invalid exclude reference' });
          return;
        }
        ribExclude = { filePath: body.exclude.filePath, line: body.exclude.line };
      }
    }
    const helixSource = isHelix ? parseHelixSource(body.source) : null;
    if (isHelix && !helixSource) {
      res.status(400).json({ success: false, reason: 'Invalid helix source' });
      return;
    }
    const axis = body.feature === 'revolve' ? parseAxis(body.axis) : null;
    if (body.feature === 'revolve' && !axis) {
      res.status(400).json({ success: false, reason: 'Invalid axis reference' });
      return;
    }
    const path = body.feature === 'sweep' ? parsePath(body.path) : null;
    if (body.feature === 'sweep' && !path) {
      res.status(400).json({ success: false, reason: 'Invalid path reference' });
      return;
    }
    const sections = isLoft ? parseSections(body.profiles) : [];
    const guides = isLoft ? parseSourceRefs(body.guides) : [];
    if (!sections || !guides) {
      res.status(400).json({ success: false, reason: 'Invalid loft sources' });
      return;
    }
    let repeat: RawRepeat | null = null;
    if (isRepeat) {
      const parsed = parseRepeat(body);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      repeat = parsed;
    }
    let copy: RawCopy | null = null;
    if (isCopy) {
      const parsed = parseCopy(body);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      copy = parsed;
    }
    let planeType: 'offset' | 'mid' | 'edge' | null = null;
    let planeBases: GhostPlaneBaseRef[] = [];
    if (isPlane) {
      if (typeof body.type !== 'string' || !PLANE_TYPES.includes(body.type)) {
        res.status(400).json({ success: false, reason: 'Invalid plane type' });
        return;
      }
      planeType = body.type as 'offset' | 'mid' | 'edge';
      const parsed = parsePlaneBases(body.bases, planeType);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      planeBases = parsed;
    }
    const startRaw = parseCondition(body.startCondition);
    const endRaw = parseCondition(body.endCondition);
    if (startRaw === 'invalid' || endRaw === 'invalid') {
      res.status(400).json({ success: false, reason: 'Invalid takeoff condition' });
      return;
    }

    const code = fluidCadServer.getCurrentCode();
    const params = new Map<string, number>(
      code
        ? resolveParamValues(await extractNumericParams(code), fluidCadServer.getParamDefinitions())
          .map(p => [p.name, p.value] as const)
        : [],
    );

    const parser = await getJavaScriptParser();
    const values: (number | null)[] = [];
    const resolve = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }
      const resolved = resolveExpr(value as ValueExpr, params, parser);
      values.push(resolved);
      return resolved;
    };

    const distance = resolve(body.distance);
    const distance2 = resolve(body.distance2);
    const draft = resolve(body.draft);
    const thickness = resolve(body.thickness);
    const angle = resolve(body.angle);
    const value = resolve(body.value);
    const thin = Array.isArray(body.thin)
      ? body.thin.map(v => resolve(v)) as [number] | [number, number]
      : null;
    const startMagnitude = startRaw ? resolve(startRaw.magnitude) : null;
    const endMagnitude = endRaw ? resolve(endRaw.magnitude) : null;
    const radius = resolve(body.radius);
    const endRadius = resolve(body.endRadius);
    const pitch = resolve(body.pitch);
    const turns = resolve(body.turns);
    const height = resolve(body.height);
    const startOffset = resolve(body.startOffset);
    const endOffset = resolve(body.endOffset);
    const count = resolve(body.count);
    const offset = resolve(body.offset);
    const rotateX = resolve(body.rotateX);
    const rotateY = resolve(body.rotateY);
    const rotateZ = resolve(body.rotateZ);
    const position = resolve(body.position);
    // The repeat and the copy state their instances identically — one pass
    // resolves whichever of the two asked.
    const rawSweep = repeat?.sweep ?? copy?.sweep ?? null;
    const sweepValue = rawSweep ? resolve(rawSweep.value) : null;
    const directions = (repeat?.directions ?? copy?.directions ?? []).map(direction => ({
      count: resolve(direction.count),
      offset: resolve(direction.offset),
      length: resolve(direction.length),
    }));

    if (values.some(v => v === null)) {
      // An expression this server can't evaluate — the client clears the ghost.
      res.json({ success: false, reason: 'That value is not a number the preview can resolve.' });
      return;
    }

    let request: FeatureGhostRequest;
    if (isBand) {
      if (value === null) {
        res.status(400).json({ success: false, reason: 'Invalid dimension' });
        return;
      }
      request = {
        feature: body.feature as 'fillet' | 'chamfer',
        value,
        // The equal-distance chamfer, and every fillet, has no second value.
        distance2: body.feature === 'chamfer' ? distance2 : null,
        isAngle: body.feature === 'chamfer' && body.isAngle === true,
        edges: edgeRefs!,
      };
    } else if (isHelix) {
      request = {
        feature: 'helix',
        source: helixSource!,
        radius,
        endRadius,
        pitch,
        turns,
        height,
        startOffset,
        endOffset,
      };
    } else if (isPlane) {
      request = {
        feature: 'plane',
        type: planeType!,
        bases: planeBases,
        offset,
        rotateX,
        rotateY,
        rotateZ,
        position,
      };
    } else if (isRepeat) {
      request = {
        feature: 'repeat',
        kind: repeat!.kind,
        targets: repeat!.targets,
        axes: repeat!.axes,
        plane: repeat!.plane,
        // Every value resolved above, or the request never reached here.
        directions: directions as GhostRepeatDirection[],
        centered: repeat!.centered,
        count,
        sweep: repeat!.sweep ? { mode: repeat!.sweep.mode, value: sweepValue! } : null,
        angle,
      };
    } else if (isCopy) {
      request = {
        feature: 'copy',
        kind: copy!.kind,
        targets: copy!.targets,
        axes: copy!.axes,
        // Every value resolved above, or the request never reached here.
        directions: directions as GhostRepeatDirection[],
        centered: copy!.centered,
        count,
        sweep: copy!.sweep ? { mode: copy!.sweep.mode, value: sweepValue! } : null,
        skip: copy!.skip,
      };
    } else if (isLoft) {
      const op = body.op as 'add' | 'remove' | 'new';
      request = {
        feature: 'loft',
        op,
        thin,
        profiles: sections,
        guides,
        startCondition: startRaw ? { type: startRaw.type, magnitude: startMagnitude! } : null,
        endCondition: endRaw ? { type: endRaw.type, magnitude: endMagnitude! } : null,
      };
    } else if (body.feature === 'sweep') {
      request = {
        feature: 'sweep',
        op: body.op as 'add' | 'remove' | 'new',
        thin,
        profile: profileRef!,
        path: path!,
      };
    } else if (isRib) {
      if (thickness === null || thickness === 0) {
        res.status(400).json({ success: false, reason: 'Invalid thickness' });
        return;
      }
      request = {
        feature: 'rib',
        op: body.op as 'add' | 'remove' | 'new',
        thickness,
        parallel: body.parallel === true,
        extend: body.extend === true,
        draft,
        spine: spineRef!,
        scope: ribScope,
        exclude: ribExclude,
      };
    } else if (isOffset) {
      // A zero distance never leaves the dialog (its sign check refuses it);
      // an absent one is a malformed request rather than a silent no-ghost.
      if (distance === null || distance === 0) {
        res.status(400).json({ success: false, reason: 'Invalid distance' });
        return;
      }
      request = {
        feature: 'offset',
        distance,
        close: body.close === true,
        entities: sketchEntities!,
      };
    } else if (body.feature === 'revolve') {
      if (angle === null) {
        res.status(400).json({ success: false, reason: 'Invalid sweep angle' });
        return;
      }
      request = {
        feature: 'revolve',
        op: body.op as 'add' | 'remove' | 'new',
        angle,
        symmetric: body.symmetric === true,
        thin,
        profile: profileRef!,
        axis: axis!,
      };
    } else {
      request = {
        feature: 'extrude',
        op: body.op as 'add' | 'remove' | 'new',
        distance,
        distance2,
        symmetric: body.symmetric === true,
        draft,
        endOffset,
        drill: body.drill !== false,
        thin,
        profile: profileRef!,
      };
    }

    const result = await fluidCadServer.featureGhost(request);
    if (!result.solids) {
      // `surface` marks the few refusals a dialog should say out loud; without
      // it the client just clears the overlay.
      res.status(result.status).json({
        success: false,
        reason: result.reason,
        surface: result.surface,
      });
      return;
    }
    res.json({ success: true, solids: result.solids });
  });

  return router;
}
