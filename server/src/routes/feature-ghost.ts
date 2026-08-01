import { Router } from 'express';
import { extractNumericParams, resolveParamValues } from '../apply-feature-edit.ts';
import type {
  FeatureGhostRequest, FluidCadServer, GhostAxisRef, GhostEntityRef, GhostHelixSourceRef,
  GhostPathRef, GhostPlaneRef, GhostRepeatDirection, GhostSectionRef,
} from '../fluidcad-server.ts';
import { MAX_REPEAT_TARGETS } from './apply-feature.ts';

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
  value?: unknown;
  isAngle?: unknown;
  edges?: unknown;
  axis?: { kind?: unknown; axis?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  profile?: { filePath?: unknown; line?: unknown };
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
};

const FEATURES = ['extrude', 'revolve', 'sweep', 'loft', 'fillet', 'chamfer', 'helix', 'repeat'];

/** The features that modify edges of an existing solid rather than sweep a profile. */
const BAND_FEATURES = ['fillet', 'chamfer'];

/** The features that sweep one profile — the only ones carrying a profile ref. */
const PROFILE_FEATURES = ['extrude', 'revolve', 'sweep'];

const OPS = ['add', 'remove', 'new'];

const STANDARD_AXES = ['x', 'y', 'z'];

const STANDARD_PLANES = ['xy', 'xz', 'yz'];

const CONDITION_TYPES = ['normal', 'tangent'];

const REPEAT_KINDS = ['linear', 'circular', 'mirror', 'rotate'];

/** The circular dialog's two angle forms: the whole sweep, or one step of it. */
const SWEEP_MODES = ['angle', 'offset'];

/** Two directions is what the repeat dialog writes; more is hand-written code. */
const MAX_GHOST_DIRECTIONS = 2;

/** A bare JS identifier — the only expression form resolvable server-side. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
 * through; a bare identifier resolves against the file's top-level numeric
 * params, exactly as apply-feature's synthesis links dimensions. There is no
 * expression evaluator server-side, so arithmetic and unknown names resolve
 * to null — the ghost then simply doesn't show.
 */
function resolveExpr(value: ValueExpr, params: Map<string, number>): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const name = value.trim();
  if (!IDENTIFIER.test(name)) {
    return null;
  }
  const resolved = params.get(name);
  return resolved !== undefined && Number.isFinite(resolved) ? resolved : null;
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
    // repeat inherits whatever its targets already do.
    const isBand = BAND_FEATURES.includes(body.feature);
    const isHelix = body.feature === 'helix';
    const isRepeat = body.feature === 'repeat';
    if (!isBand && !isHelix && !isRepeat && (typeof body.op !== 'string' || !OPS.includes(body.op))) {
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
      || !isValueExprOrNull(body.endOffset)) {
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

    const values: (number | null)[] = [];
    const resolve = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }
      const resolved = resolveExpr(value as ValueExpr, params);
      values.push(resolved);
      return resolved;
    };

    const distance = resolve(body.distance);
    const distance2 = resolve(body.distance2);
    const draft = resolve(body.draft);
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
    const sweepValue = repeat?.sweep ? resolve(repeat.sweep.value) : null;
    const directions = (repeat?.directions ?? []).map(direction => ({
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
    } else if (body.feature === 'revolve') {
      if (angle === null) {
        res.status(400).json({ success: false, reason: 'Invalid sweep angle' });
        return;
      }
      request = {
        feature: 'revolve',
        op: body.op as 'add' | 'remove' | 'new',
        angle,
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
