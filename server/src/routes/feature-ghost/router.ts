// The feature-ghost router: validates a ghost request and asks the server for the preview solids.

import { Router } from 'express';
import type { PlaneRotationAxes } from '../../apply-feature-edit/index.ts';
import type {
  FeatureGhostRequest,
  FluidCadServer,
  HoleGhostRequest,
  GhostEntityRef,
  GhostPlaneBaseRef,
  GhostRepeatDirection,
} from '../../fluidcad-server/index.ts';
import { MAX_COPY_TARGETS, validateRegionPicks } from '../apply-feature/index.ts';
import type { RegionPickSpec } from '../../apply-feature-edit/index.ts';
import { parseCondition, parseLoftConnections } from './loft.ts';
import {
  parseAxis,
  parseEntityRefs,
  parseHelixSource,
  parsePath,
  parsePlaneBases,
  parseSections,
  parseSketchEntityRefs,
  parseSourceRefs,
} from './refs.ts';
import {
  parseCopy,
  parseCopy2D,
  parseMirror,
  parseMirror2D,
  parseRepeat,
  parseRotate,
  type RawCopy,
  type RawCopy2D,
  type RawMirror,
  type RawMirror2D,
  type RawRepeat,
  type RawRotate,
} from './transforms.ts';
import { ValueScope } from './value-scope.ts';
import { isThin, isValueExprOrNull, type ValueExpr } from './values.ts';
import { BAND_FEATURES, FEATURES, OPS, PLANE_TYPES, PROFILE_FEATURES, type GhostBody } from './vocabulary.ts';

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
    // The mirror is NOT exempt: its reflected bodies land the way its own op
    // says (fuse, cut, or standalone), so the dialog declares one.
    const isMirror = body.feature === 'mirror';
    // The rotate IS exempt: it moves (or copies) bodies, no boolean involved.
    const isRotate = body.feature === 'rotate';
    const isPlane = body.feature === 'plane';
    // The 2D ops rework curves inside their sketch — there is no add/remove/new.
    const isOffset = body.feature === 'offset';
    const isFillet2D = body.feature === 'fillet2d';
    const isCopy2D = body.feature === 'copy2d';
    const isMirror2D = body.feature === 'mirror2d';
    // A hole is always a removal — no op to declare.
    const isHole = body.feature === 'hole';
    if (!isHole && !isBand && !isHelix && !isRepeat && !isCopy && !isRotate && !isPlane && !isOffset
      && !isFillet2D && !isCopy2D && !isMirror2D && (typeof body.op !== 'string' || !OPS.includes(body.op))) {
      res.status(400).json({ success: false, reason: 'Invalid op' });
      return;
    }
    if (!isValueExprOrNull(body.distance) || !isValueExprOrNull(body.distance2)
      || !isValueExprOrNull(body.draft) || !isValueExprOrNull(body.angle)
      || !isValueExprOrNull(body.value) || !isValueExprOrNull(body.count)
      || !isThin(body.thin)
      || !isValueExprOrNull(body.extendStart) || !isValueExprOrNull(body.extendEnd)
      || !isValueExprOrNull(body.radius) || !isValueExprOrNull(body.endRadius)
      || !isValueExprOrNull(body.pitch) || !isValueExprOrNull(body.turns)
      || !isValueExprOrNull(body.height) || !isValueExprOrNull(body.startOffset)
      || !isValueExprOrNull(body.endOffset)
      || !isValueExprOrNull(body.offset) || !isValueExprOrNull(body.rotateX)
      || !isValueExprOrNull(body.rotateY) || !isValueExprOrNull(body.rotateZ)
      || !isValueExprOrNull(body.position) || !isValueExprOrNull(body.thickness)
      || !isValueExprOrNull(body.diameter) || !isValueExprOrNull(body.depth) || !isValueExprOrNull(body.tipAngle)
      || !isValueExprOrNull(body.counterbore?.diameter) || !isValueExprOrNull(body.counterbore?.depth)
      || !isValueExprOrNull(body.countersink?.diameter) || !isValueExprOrNull(body.countersink?.angle)) {
      res.status(400).json({ success: false, reason: 'Invalid dimension' });
      return;
    }
    const valueScope = ValueScope.parse(body.valueScope);
    if (valueScope === 'invalid') {
      res.status(400).json({ success: false, reason: 'Invalid value scope' });
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
    if (isOffset || isFillet2D) {
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
    // The dialog's region picks — absent means every region. Validated by
    // the apply path's own rule so a ghost can't build what the apply refuses.
    let regions: RegionPickSpec[] | undefined;
    if (PROFILE_FEATURES.includes(body.feature) && body.regions !== undefined && body.regions !== null) {
      const parsed = validateRegionPicks(body);
      if ('error' in parsed) {
        res.status(400).json({ success: false, reason: parsed.error });
        return;
      }
      regions = parsed.regions;
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
    let holeFrames: HoleGhostRequest['frames'] = [];
    let holeScope: { filePath: string; line: number }[] = [];
    let holeExclude: { filePath: string; line: number } | undefined;
    if (isHole) {
      const frames = parseHoleFrames(body.frames);
      if (!frames) {
        res.status(400).json({ success: false, reason: 'Invalid hole frames' });
        return;
      }
      holeFrames = frames;
      const scope = parseSourceRefs(body.scope ?? []);
      if (!scope || scope.length > MAX_COPY_TARGETS) {
        res.status(400).json({ success: false, reason: 'Invalid scope references' });
        return;
      }
      holeScope = scope;
      if (body.exclude !== undefined && body.exclude !== null) {
        if (typeof body.exclude.filePath !== 'string' || typeof body.exclude.line !== 'number') {
          res.status(400).json({ success: false, reason: 'Invalid exclude reference' });
          return;
        }
        holeExclude = { filePath: body.exclude.filePath, line: body.exclude.line };
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
    const connections = isLoft ? parseLoftConnections(body.connections, sections.length) : [];
    if (connections === null) {
      res.status(400).json({ success: false, reason: 'Invalid loft connections: each connection needs one finite xyz point per profile' });
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
    let mirror: RawMirror | null = null;
    if (isMirror) {
      const parsed = parseMirror(body);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      mirror = parsed;
    }
    let rotate: RawRotate | null = null;
    if (isRotate) {
      const parsed = parseRotate(body);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      rotate = parsed;
    }
    let copy2d: RawCopy2D | null = null;
    if (isCopy2D) {
      const parsed = parseCopy2D(body);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      copy2d = parsed;
    }
    let mirror2d: RawMirror2D | null = null;
    if (isMirror2D) {
      const parsed = parseMirror2D(body);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, reason: parsed });
        return;
      }
      mirror2d = parsed;
    }
    let planeType: 'offset' | 'mid' | 'edge' | null = null;
    let planeBases: GhostPlaneBaseRef[] = [];
    // The axes the plane's rotations turn around; absent reads as the
    // plane's own.
    let planeAxes: PlaneRotationAxes = 'local';
    if (isPlane) {
      if (typeof body.type !== 'string' || !PLANE_TYPES.includes(body.type)) {
        res.status(400).json({ success: false, reason: 'Invalid plane type' });
        return;
      }
      planeType = body.type as 'offset' | 'mid' | 'edge';
      if (body.rotationAxes !== undefined && body.rotationAxes !== 'local' && body.rotationAxes !== 'world') {
        res.status(400).json({ success: false, reason: 'Invalid plane rotationAxes' });
        return;
      }
      planeAxes = (body.rotationAxes as PlaneRotationAxes | undefined) ?? 'local';
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

    // A dialog value names variables the way its statement will read them,
    // so `depth` resolves to the `param()` of the part the statement lives
    // in — see ValueScope.
    const scope = await ValueScope.open({
      code: fluidCadServer.getCurrentCode(),
      filePath: fluidCadServer.getCurrentFileName(),
      definitions: fluidCadServer.getParamDefinitions(),
      instances: fluidCadServer.getRenderedInstances(),
      parts: fluidCadServer.getRenderedParts(),
    }, valueScope);
    const values: (number | null)[] = [];
    const resolve = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }
      const resolved = scope.resolve(value as ValueExpr);
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
    const extendStart = resolve(body.extendStart);
    const extendEnd = resolve(body.extendEnd);
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
    const holeDiameter = isHole ? resolve(body.diameter) : null;
    const holeDepth = isHole ? resolve(body.depth) : null;
    const holeTip = isHole ? resolve(body.tipAngle) : null;
    const holeCounterbore = isHole && body.counterbore
      ? { diameter: resolve(body.counterbore.diameter), depth: resolve(body.counterbore.depth) }
      : null;
    const holeCountersink = isHole && body.countersink
      ? { diameter: resolve(body.countersink.diameter), angle: resolve(body.countersink.angle) }
      : null;
    // The repeat and both copies state their instances identically — one pass
    // resolves whichever of the three asked.
    const rawSweep = repeat?.sweep ?? copy?.sweep ?? copy2d?.sweep ?? null;
    const sweepValue = rawSweep ? resolve(rawSweep.value) : null;
    const directions = (repeat?.directions ?? copy?.directions ?? copy2d?.directions ?? []).map(direction => ({
      count: resolve(direction.count),
      offset: resolve(direction.offset),
      length: resolve(direction.length),
    }));
    const center2d = copy2d?.center
      ? [resolve(copy2d.center[0]), resolve(copy2d.center[1])]
      : null;

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
        rotationAxes: planeAxes,
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
        ...(copy!.pattern ? { pattern: copy!.pattern } : {}),
      };
    } else if (isMirror) {
      request = {
        feature: 'mirror',
        op: body.op as 'add' | 'remove' | 'new',
        targets: mirror!.targets,
        plane: mirror!.plane,
      };
    } else if (isRotate) {
      if (angle === null) {
        res.status(400).json({ success: false, reason: 'Invalid rotation angle' });
        return;
      }
      request = {
        feature: 'rotate',
        targets: rotate!.targets,
        axis: rotate!.axis,
        angle,
      };
    } else if (isMirror2D) {
      request = {
        feature: 'mirror2d',
        entities: mirror2d!.entities,
        axis: mirror2d!.axis,
      };
    } else if (isCopy2D) {
      request = {
        feature: 'copy2d',
        kind: copy2d!.kind,
        entities: copy2d!.entities,
        axes: copy2d!.axes,
        // Every value resolved above, or the request never reached here.
        directions: directions as GhostRepeatDirection[],
        centered: copy2d!.centered,
        center: center2d ? [center2d[0]!, center2d[1]!] : null,
        count,
        sweep: copy2d!.sweep ? { mode: copy2d!.sweep.mode, value: sweepValue! } : null,
        skip: copy2d!.skip,
      };
    } else if (isLoft) {
      const op = body.op as 'add' | 'remove' | 'new';
      request = {
        feature: 'loft',
        op,
        thin,
        profiles: sections,
        guides,
        connections,
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
        extendStart,
        extendEnd,
        regions,
      };
    } else if (isHole) {
      // The transform refuses these too; the ghost says so instead of a blank viewport.
      if (holeDiameter === null || holeDiameter <= 0) {
        res.status(400).json({ success: false, reason: 'Invalid diameter' });
        return;
      }
      if (holeCounterbore && (holeCounterbore.diameter === null || holeCounterbore.depth === null)) {
        res.status(400).json({ success: false, reason: 'Invalid counterbore' });
        return;
      }
      if (holeCountersink && (holeCountersink.diameter === null || holeCountersink.angle === null)) {
        res.status(400).json({ success: false, reason: 'Invalid countersink' });
        return;
      }
      request = {
        feature: 'hole',
        frames: holeFrames,
        diameter: holeDiameter,
        depth: holeDepth,
        tipAngle: holeDepth === null ? null : holeTip,
        counterbore: holeCounterbore as { diameter: number; depth: number } | null,
        countersink: holeCountersink as { diameter: number; angle: number } | null,
        scope: holeScope,
        exclude: holeExclude,
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
    } else if (isFillet2D) {
      // A non-positive radius never leaves the dialog (its sign check refuses
      // it); an absent one is a malformed request rather than a silent
      // no-ghost.
      if (radius === null || radius <= 0) {
        res.status(400).json({ success: false, reason: 'Invalid radius' });
        return;
      }
      request = {
        feature: 'fillet2d',
        radius,
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
        regions,
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
        regions,
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
    res.json({ success: true, solids: result.solids, ...(result.frames ? { frames: result.frames } : {}) });
  });

  /**
   * The region picker's faces: every closed region of a profile, keyed and
   * meshed, with the dialog's current picks marked — what the feature dialogs
   * draw over the sketch when the user clicks "Pick regions". Read-only, the
   * ghost's sibling: nothing here writes code or scene state.
   */
  router.post('/sketch-regions', async (req, res) => {
    const body = (req.body ?? {}) as { profile?: { filePath?: unknown; line?: unknown }; picks?: unknown };
    const profile = body.profile;
    if (typeof profile?.filePath !== 'string' || typeof profile?.line !== 'number') {
      res.status(400).json({ success: false, reason: 'Invalid profile reference' });
      return;
    }
    const picks = validateRegionPicks({ regions: body.picks });
    if ('error' in picks) {
      res.status(400).json({ success: false, reason: picks.error });
      return;
    }
    const result = await fluidCadServer.sketchRegions({
      profile: { filePath: profile.filePath, line: profile.line },
      picks: picks.regions,
    });
    if (!result.regions) {
      res.status(result.status).json({ success: false, reason: result.reason });
      return;
    }
    res.json({ success: true, regions: result.regions });
  });

  /**
   * The sketcher's constrained Offset plan: the picked edges offset by OCCT
   * with sharp corners, each result edge described as the line/arc/circle
   * the tool writes plus the source it follows, and the wires meshed as the
   * dialog's ghost. Read-only, the ghost's sibling.
   */
  router.post('/sketch-offset-plan', async (req, res) => {
    const body = (req.body ?? {}) as { entities?: unknown; distance?: unknown; close?: unknown };
    const entities = parseSketchEntityRefs(body.entities);
    if (!entities || entities.length === 0) {
      res.status(400).json({ success: false, reason: 'Invalid edge selection' });
      return;
    }
    if (typeof body.distance !== 'number' || !Number.isFinite(body.distance) || body.distance === 0) {
      res.status(400).json({ success: false, reason: 'Invalid distance' });
      return;
    }
    const result = await fluidCadServer.sketchOffsetPlan({
      entities,
      distance: body.distance,
      close: body.close === true,
    });
    if (!result.chains) {
      res.status(result.status).json({ success: false, reason: result.reason });
      return;
    }
    res.json({ success: true, chains: result.chains, solids: result.solids ?? [] });
  });

  return router;
}

/** The hole's placement frames: finite xyz origin + normal triples. */
function parseHoleFrames(value: unknown): HoleGhostRequest['frames'] | null {
  if (!Array.isArray(value) || value.length > 256) {
    return null;
  }
  const triple = (raw: unknown): [number, number, number] | null =>
    Array.isArray(raw) && raw.length === 3 && raw.every(v => typeof v === 'number' && Number.isFinite(v))
      ? [raw[0], raw[1], raw[2]]
      : null;
  const frames: HoleGhostRequest['frames'] = [];
  for (const raw of value) {
    const origin = triple((raw as { origin?: unknown })?.origin);
    const normal = triple((raw as { normal?: unknown })?.normal);
    if (!origin || !normal || normal.every(v => v === 0)) {
      return null;
    }
    frames.push({ origin, normal });
  }
  return frames;
}
