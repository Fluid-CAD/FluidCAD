// In-place statement edit request validation: the per-feature option slots an edit dialog commits.

import {
  validConnectorAnchor,
  validConnectorRotate,
  validValueExpr,
  type ApplyFeatureEditSpec,
  type ConnectorAnchorSpec,
  type FeatureStatementEditTarget,
  type OffsetEditOptions,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import {
  validateScopeEdits,
  validateSketchLoc,
  type EditScopeTargetInput,
  type SketchLoc,
} from '../locations.ts';
import { validateChains, validatePick, validatePicks, validateSketchPicks, type Pick } from '../picks.ts';
import { validateRegionEdits } from '../regions.ts';
import { validateBooleanEdit } from './boolean.ts';
import { isKeepSlot, validateProfileFeature, validateThinOffsets } from './common.ts';
import { validateCopyEdit, type CopyEditAxisInput } from './copy.ts';
import { validateExtrudeOptions } from './extrude.ts';
import { validateHelixOption, validateHelixSource, type HelixSourceInput } from './helix.ts';
import {
  validateEditLoftGuides,
  validateEditLoftProfiles,
  validateLoftCondition,
  validateLoftConnections,
  type EditLoftGuideInput,
  type EditLoftProfileInput,
  type LoftConnectionInput,
} from './loft.ts';
import { validateMirrorEdit } from './mirror.ts';
import {
  validateChamferOptions,
  validateOffsetOptions,
  validateShellJoinType,
  validateTextOptions,
} from './options.ts';
import { validatePlaneEdit, type PlaneEditBaseInput } from './plane.ts';
import { MAX_PROJECT_SKETCHES, validateProjectSketches } from './project.ts';
import { validateRepeatEdit, type RepeatEditAxisInput, type RepeatPlaneInput } from './repeat.ts';
import { validateRevolveAxis, type RevolveAxisInput } from './revolve.ts';
import { validateRibOptions } from './rib.ts';
import { validateRotateEdit } from './rotate.ts';
import { validateSweepExtend } from './sweep.ts';

/** Features whose statements the dialogs can rewrite in place. */
const EDITABLE_FEATURES = new Set(['extrude', 'sweep', 'loft', 'shell', 'fillet', 'chamfer', 'revolve', 'text', 'wrap', 'sketch', 'repeat', 'copy', 'mirror', 'rotate', 'boolean', 'helix', 'plane', 'offset', 'project', 'rib', 'connector']);

export type StatementEditRequest = {
  feature: ApplyFeatureEditSpec['feature'];
  target: SketchLoc;
  edit: FeatureStatementEditTarget;
  value?: ValueExpr;
  rawArgs?: string;
  /** Offset's toggles; always explicit on an edit (a cleared box clears the option). */
  offset?: OffsetEditOptions;
  /** Re-picked selection for shell/fillet/chamfer; absent keeps the args. */
  picks?: Pick[];
  chains?: { seed: Pick; members: Pick[] }[];
  /**
   * A re-sourced projection's whole-sketch references (`project(s1)`), by
   * call site; set together with `picks` (either may be empty). Absent
   * keeps the statement's own arguments.
   */
  projectSketches?: SketchLoc[];
  /** Re-picked sketch edges for a 2D offset; absent keeps the args. */
  sketchPicks?: { shapeId: string }[];
  /** Re-sourced extrude profile sketch; absent keeps the statement's. */
  extrudeProfile?: SketchLoc & { feature: 'sketch' | 'offset' };
  /** Re-picked extrude up-to-face target; the keep case rides the edit target. */
  extrudeToFace?: Pick;
  /** Re-sourced rib spine sketch; absent keeps the statement's. */
  ribSpine?: SketchLoc;
  /**
   * Full replacement `.scope(…)` list, mixing kept targets (`verbatim` by
   * source index) with re-picked solid statements; absent keeps the
   * statement's own chain, `[]` drops it. Shared by every feature dialog
   * that writes the chain (rib, extrude, sweep, loft, revolve).
   */
  scope?: EditScopeTargetInput[];
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
  loftConnections?: LoftConnectionInput[];
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
  copyDirections?: { axis: CopyEditAxisInput; count: ValueExpr; value: ValueExpr }[];
  /** Edited copy's axis (circular); keep stays by source position. */
  copyAxis?: CopyEditAxisInput;
  /** Full replacement copy target list; absent keeps the statement's. */
  copyTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /**
   * Full replacement 2D copy target list — sketch-edge picks in argument
   * order, resolved to whole geometries by the sketch synthesis kernel.
   * The pause-before contract applies: no boundary rides along.
   */
  copySketchTargets?: { shapeId: string }[];
  /** The 2D copy's axis edge picks, one per sketch-edge direction in order. */
  copyAxisPicks?: { shapeId: string }[];
  /** Edited mirror's plane; keep stays the statement's own text. */
  mirrorPlane?: { kind: 'keep' } | RepeatPlaneInput;
  /** Full replacement mirror target list; absent keeps the statement's. */
  mirrorTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /**
   * Edited 2D mirror's line (the in-sketch form, where the plane slot would
   * be); keep stays the statement's own text, a picked sketch line rides
   * `mirrorAxisPicks`.
   */
  mirrorAxis?: { kind: 'keep' } | { kind: 'local'; axis: 'x' | 'y' } | { kind: 'sketch-edge' };
  /**
   * Full replacement 2D mirror target list — sketch-edge picks in argument
   * order, resolved to whole geometries by the sketch synthesis kernel.
   * The pause-before contract applies: no boundary rides along.
   */
  mirrorSketchTargets?: { shapeId: string }[];
  /** The 2D mirror's line pick — exactly one for a sketch-edge axis. */
  mirrorAxisPicks?: { shapeId: string }[];
  /** Edited rotate's axis; keep stays the statement's own text. */
  rotateAxis?: { kind: 'keep' } | RevolveAxisInput;
  /** Full replacement rotate target list; absent keeps the statement's. */
  rotateTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /** Full replacement boolean target list; absent keeps the statement's. */
  booleanTargets?: ({ kind: 'verbatim'; sourceIndex: number } | { kind: 'feature'; loc: SketchLoc })[];
  /** Full replacement plane base list; absent keeps the statement's. */
  planeBases?: PlaneEditBaseInput[];
  /**
   * The anchor a re-picked connector source narrows to; it rides the
   * synthesis, which appends the suffix to the args it renders.
   */
  connectorAnchor?: ConnectorAnchorSpec;
  /** True when a source payload carries picks — synthesis needs a boundary. */
  needsPicks: boolean;
};

/**
 * The in-place edit request's shape: the statement location plus the
 * dialog-editable options for that feature, plus optional re-sourced slots —
 * a re-picked selection, profile, path, or profile/guide list. Slots the
 * request omits are re-read from the statement at apply time and preserved
 * verbatim.
 */
export function validateStatementEdit(body: any): StatementEditRequest | { error: string } {
  const { feature, selectorOverride } = body ?? {};
  if (typeof feature !== 'string' || !EDITABLE_FEATURES.has(feature)) {
    return { error: 'feature must be "extrude", "rib", "sweep", "wrap", "loft", "revolve", "helix", "plane", "shell", "fillet", "chamfer", "text", "sketch", "repeat", "copy", "mirror", "rotate", "boolean", "offset" or "project" for an edit' };
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
    const scopeResult = validateScopeEdits(body);
    if ('error' in scopeResult) {
      return scopeResult;
    }
    result.scope = scopeResult.scope;
    const regionResult = validateRegionEdits(body);
    if ('error' in regionResult) {
      return regionResult;
    }
    edit.extrude.regions = regionResult.regions;
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
    const profileFeature = validateProfileFeature(body.profile?.feature);
    if (body.profile?.mode !== 'bound' || !loc || !profileFeature) {
      return { error: 'an edited profile must be {mode: "bound", filePath, line} of the sketch or offset' };
    }
    return { ...result, extrudeProfile: { ...loc, feature: profileFeature } };
  }

  if (feature === 'rib') {
    const options = validateRibOptions(body);
    if ('error' in options) {
      return options;
    }
    edit.rib = options;
    const result: StatementEditRequest = base;
    const scopeResult = validateScopeEdits(body);
    if ('error' in scopeResult) {
      return scopeResult;
    }
    result.scope = scopeResult.scope;
    if (isKeepSlot(body?.spine)) {
      return result;
    }
    const loc = validateSketchLoc(body.spine);
    if (body.spine?.mode !== 'bound' || !loc) {
      return { error: 'an edited spine must be {mode: "bound", filePath, line} of the sketch' };
    }
    return { ...result, ribSpine: loc };
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
    const regionResult = validateRegionEdits(body);
    if ('error' in regionResult) {
      return regionResult;
    }
    edit.wrap.regions = regionResult.regions;
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
    const { op, angle, symmetric } = body ?? {};
    if (op !== 'add' && op !== 'remove' && op !== 'new') {
      return { error: 'op must be "add", "remove" or "new"' };
    }
    if (!validValueExpr(angle, { nonzero: true })) {
      return { error: 'angle must be a nonzero sweep angle in degrees' };
    }
    if (symmetric !== undefined && typeof symmetric !== 'boolean') {
      return { error: 'symmetric must be a boolean' };
    }
    const thin = validateThinOffsets(body?.thin);
    if ('error' in thin) {
      return thin;
    }
    edit.revolve = { op, angle, symmetric: symmetric === true, thin: thin.offsets };
    const result: StatementEditRequest = base;
    const scopeResult = validateScopeEdits(body);
    if ('error' in scopeResult) {
      return scopeResult;
    }
    result.scope = scopeResult.scope;
    const regionResult = validateRegionEdits(body);
    if ('error' in regionResult) {
      return regionResult;
    }
    edit.revolve.regions = regionResult.regions;
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
      const extend = validateSweepExtend(body);
      if ('error' in extend) {
        return extend;
      }
      edit.sweep = { op, thin: thin.offsets, ...extend };
      const result: StatementEditRequest = base;
      const scopeResult = validateScopeEdits(body);
      if ('error' in scopeResult) {
        return scopeResult;
      }
      result.scope = scopeResult.scope;
      const regionResult = validateRegionEdits(body);
      if ('error' in regionResult) {
        return regionResult;
      }
      edit.sweep.regions = regionResult.regions;
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
    const scopeResult = validateScopeEdits(body);
    if ('error' in scopeResult) {
      return scopeResult;
    }
    result.scope = scopeResult.scope;
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
    const connections = validateLoftConnections(body.connections, true, result.loftProfiles?.length);
    if ('error' in connections) {
      return connections;
    }
    result.loftConnections = connections.connections;
    result.needsPicks ||= connections.connections?.some(row => row.kind === 'points'
      && row.points.some(point => point.kind === 'vertex')) ?? false;
    return result;
  }

  if (feature === 'text') {
    const options = validateTextOptions(body);
    if ('error' in options) {
      return options;
    }
    edit.text = options.options;
    // The path argument: absent keeps the statement's own text verbatim,
    // `none` drops it, `picked` re-sources it from the sketch-edge picks
    // (no boundary — the double-click paused the build at the edited
    // statement, so the rendered sketch already IS the world it sees).
    const path = body?.path;
    if (path === undefined || path === null) {
      return base;
    }
    if (path.kind === 'none') {
      if (body?.sketchEntities !== undefined) {
        return { error: 'a removed path takes no sketchEntities' };
      }
      edit.text.path = { kind: 'none' };
      return base;
    }
    if (path.kind !== 'picked') {
      return { error: 'path must be {kind: "none"} or {kind: "picked"}' };
    }
    const picks = validateSketchPicks(body?.sketchEntities);
    if (!picks) {
      return { error: 'sketchEntities must be a non-empty array of {shapeId} picks' };
    }
    edit.text.path = { kind: 'selector' };
    const result: StatementEditRequest = base;
    result.sketchPicks = picks;
    return result;
  }

  if (feature === 'repeat') {
    return validateRepeatEdit(body, base, edit);
  }

  if (feature === 'copy') {
    return validateCopyEdit(body, base, edit);
  }

  if (feature === 'mirror') {
    return validateMirrorEdit(body, base, edit);
  }

  if (feature === 'rotate') {
    return validateRotateEdit(body, base, edit);
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
    // A re-sourced edit sends both lists (either may be empty, not both);
    // neither present keeps the statement's own arguments.
    const resourced = (body?.entities !== undefined && body?.entities !== null)
      || (body?.sketches !== undefined && body?.sketches !== null);
    if (resourced) {
      const sketches = validateProjectSketches(body?.sketches);
      if (!sketches) {
        return { error: `sketches must be an array of at most ${MAX_PROJECT_SKETCHES} {filePath, line, column} sketch call sites` };
      }
      const hasEntities = Array.isArray(body?.entities) && body.entities.length > 0;
      const picks = hasEntities ? validatePicks(body.entities) : [];
      if (!picks) {
        return { error: 'entities must be an array of {shapeId, sub:{type, index}} picks' };
      }
      if (picks.length === 0 && sketches.length === 0) {
        return { error: 'pick at least one source: entities (edges/faces) or sketches' };
      }
      const chains = validateChains(body?.chains);
      if (!chains) {
        return { error: 'chains must be {seed, members} pick groups' };
      }
      result.picks = picks;
      result.chains = chains;
      result.projectSketches = sketches;
      result.needsPicks = picks.length > 0;
    }
    return result;
  }

  // Connector: the registered name plus the two frame adjustments — always
  // explicit, so clearing the rotation stepper or an offset field drops that
  // chain instead of keeping the statement's own. The source is either the
  // edited expression row, a re-picked face/edge (whose anchor rides along,
  // since the synthesis renders the suffix), or the statement's own text.
  if (feature === 'connector') {
    const name = body?.name;
    if (typeof name !== 'string' || name.length > 64 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      return { error: 'name must be a plain identifier (max 64 chars)' };
    }
    const rotate = body?.rotate ?? undefined;
    if (!validConnectorRotate(rotate)) {
      return { error: "rotate must be { axis: 'x'|'y'|'z', angle } with a finite angle in degrees" };
    }
    const frameOffset = body?.offset ?? undefined;
    if (frameOffset !== undefined
      && !(Array.isArray(frameOffset) && frameOffset.length === 3 && frameOffset.every((v: unknown) => Number.isFinite(v)))) {
      return { error: 'offset must be [x, y, z] finite numbers' };
    }
    if (selectorOverride !== undefined
      && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
      return { error: 'selectorOverride must be a non-empty string (max 500 chars)' };
    }
    edit.connector = { name, rotate: rotate ?? null, offset: frameOffset ?? null };
    const result: StatementEditRequest = {
      ...base,
      rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
    };
    if (body?.entities !== undefined && body?.entities !== null) {
      const picks = validatePicks(body.entities);
      if (!picks || picks.length !== 1) {
        return { error: 'entities must be the single {shapeId, sub:{type, index}} pick the connector attaches to' };
      }
      const anchor = body?.anchor;
      if (!validConnectorAnchor(anchor)) {
        return { error: "anchor must be {kind: 'center'|'start'|'end'} or {kind: 'offset', mode: 'relative'|'absolute', value}" };
      }
      result.picks = picks;
      result.chains = [];
      result.connectorAnchor = anchor;
      // The synthesis renders the parts bare; the transform appends the
      // suffix to them, the same way the create path does.
      edit.connector.anchor = anchor;
      result.needsPicks = true;
    }
    return result;
  }

  // Offset: the distance, both toggles, and either an edited target list
  // (the expression row) or a re-picked selection. A sketch offset re-picks
  // sketch edges (`sketchEntities` — no boundary: the double-click paused the
  // build at the edited statement, so the rendered sketch already IS the
  // world it sees); a top-level face offset re-picks 3D faces (`entities`),
  // synthesized boundary-scoped like the fillet/shell edit dialogs'.
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
    } else if (body?.entities !== undefined && body?.entities !== null) {
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
  // A 2D fillet (inside a sketch body) re-picks sketch edges instead of 3D
  // entities — the offset edit's contract: the picks carry no boundary, since
  // the double-click paused the build at the edited statement.
  if (feature === 'fillet' && body?.sketchEntities !== undefined && body?.sketchEntities !== null) {
    if (body?.entities !== undefined && body?.entities !== null) {
      return { error: 'a fillet edit carries entities (3D) or sketchEntities (2D), not both' };
    }
    const picks = validateSketchPicks(body.sketchEntities);
    if (!picks) {
      return { error: 'sketchEntities must be a non-empty array of {shapeId} picks' };
    }
    result.sketchPicks = picks;
    return result;
  }
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
