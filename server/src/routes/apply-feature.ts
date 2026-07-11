import { Router } from 'express';
import type { FluidCadServer } from '../fluidcad-server.ts';
import {
  applyFeatureEdit, extractNumericParams, makeProducerNamer, parseFeatureStatement, renderEditedStatement,
  renderExtrudeStatement, renderLoftStatement, renderPlaneBaseExprs, renderPlaneStatement,
  renderSelectorPartExpr, renderSweepStatement, resolveParamValues,
  resolveSketchNames,
  type ApplyFeatureEditSpec, type ExtrudeEditOptions, type FeatureStatementEditTarget, type LoftEditOptions,
  type PlaneEditOptions, type SweepEditOptions,
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
 * The extrude request's shape. No pick selection: the profile is a sketch —
 * `active` consumes it implicitly, `bound` binds it to a variable.
 */
type ExtrudeRequest = ExtrudeOptionSet & {
  profile: { mode: 'active' | 'bound' } & SketchLoc;
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
 */
function validateExtrudeOptions(body: any): ExtrudeOptionSet | { error: string } {
  const { op, distance, distance2, symmetric, draft, drill, thin } = body ?? {};
  if (op !== 'add' && op !== 'remove' && op !== 'new') {
    return { error: 'op must be "add", "remove" or "new"' };
  }
  if (distance === null) {
    if (op !== 'remove') {
      return { error: 'distance may be null (through-all) only for a remove' };
    }
  } else if (!isNonzeroNumber(distance)) {
    return { error: 'distance must be a nonzero number (negative extrudes the other way)' };
  }
  if (distance2 !== undefined && distance2 !== null) {
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
    distance,
    distance2: distance2 ?? null,
    symmetric: symmetric === true,
    draft: draft ?? null,
    drill: drill !== false,
    thin: thinResult.offsets,
  };
}

function validateExtrude(body: any): ExtrudeRequest | { error: string } {
  const options = validateExtrudeOptions(body);
  if ('error' in options) {
    return options;
  }
  const mode = body?.profile?.mode;
  const loc = validateSketchLoc(body?.profile);
  if ((mode !== 'active' && mode !== 'bound') || !loc) {
    return { error: 'profile must be {mode: "active"|"bound", filePath, line} of the sketch' };
  }
  return { ...options, profile: { mode, ...loc } };
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
const EDITABLE_FEATURES = new Set(['extrude', 'sweep', 'loft', 'shell', 'fillet', 'chamfer']);

type StatementEditRequest = {
  feature: ApplyFeatureEditSpec['feature'];
  target: SketchLoc;
  edit: FeatureStatementEditTarget;
  value?: number;
  rawArgs?: string;
};

/**
 * The in-place edit request's shape: the statement location plus the
 * dialog-editable options for that feature. Everything the dialog doesn't
 * edit is re-read from the statement at apply time, so nothing else rides.
 */
function validateStatementEdit(body: any): StatementEditRequest | { error: string } {
  const { feature, selectorOverride } = body ?? {};
  if (typeof feature !== 'string' || !EDITABLE_FEATURES.has(feature)) {
    return { error: 'feature must be "extrude", "sweep", "loft", "shell", "fillet" or "chamfer" for an edit' };
  }
  const target = validateSketchLoc(body?.edit);
  if (!target) {
    return { error: 'edit must be the {filePath, line, column} of the feature statement' };
  }
  const edit: FeatureStatementEditTarget = { line: target.line, column: target.column };
  const kind = feature as ApplyFeatureEditSpec['feature'];
  const base = { feature: kind, target, edit };

  if (feature === 'extrude') {
    const options = validateExtrudeOptions(body);
    if ('error' in options) {
      return options;
    }
    edit.extrude = options;
    return base;
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
      return base;
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
    return base;
  }

  // Shell / fillet / chamfer: the numeric value plus an optional edited
  // selector argument list (the expression row).
  const { value } = body ?? {};
  if (feature === 'shell') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
      return { error: 'value must be a nonzero number (negative hollows inward)' };
    }
  } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { error: 'value must be a positive number' };
  }
  if (selectorOverride !== undefined
    && (typeof selectorOverride !== 'string' || selectorOverride.trim().length === 0 || selectorOverride.length > 500)) {
    return { error: 'selectorOverride must be a non-empty string (max 500 chars)' };
  }
  return {
    ...base,
    value,
    rawArgs: typeof selectorOverride === 'string' ? selectorOverride.trim() : undefined,
  };
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
    try {
      const result = fluidCadServer.explainSelection(picks);
      if (!result) {
        res.status(404).json({ error: 'No rendered scene' });
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
    // dialog options replaced — no pick synthesis is involved.
    if (req.body?.edit !== undefined && req.body?.edit !== null) {
      const request = validateStatementEdit(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        // The transform edits the live buffer's file only.
        const currentFile = fluidCadServer.getCurrentFileName();
        if (currentFile && normalizePath(request.target.filePath) !== normalizePath(currentFile)) {
          res.status(422).json({ success: false, reason: 'that feature lives in a different file than the one being edited' });
          return;
        }
        const spec: ApplyFeatureEditSpec = {
          feature: request.feature,
          value: request.value,
          rawArgs: request.rawArgs,
          filePath: request.target.filePath,
          producers: [],
          parts: [],
          imports: [],
          edit: request.edit,
        };
        // Truthful preview: parse the live buffer and render the exact
        // statement the transform will write. Refusals (a reshaped or
        // non-literal statement) surface here, before any edit is sent.
        let statement: string | undefined;
        const code = fluidCadServer.getCurrentCode();
        if (code) {
          const parsed = await parseFeatureStatement(code, request.edit.line);
          if (parsed.ok === false) {
            res.status(422).json({ success: false, reason: parsed.reason });
            return;
          }
          const rendered = renderEditedStatement(parsed.parsed, spec);
          if ('error' in rendered) {
            res.status(422).json({ success: false, reason: rendered.error });
            return;
          }
          statement = rendered.statement;
        }
        if (preview === true) {
          res.json({ success: true, preview: statement });
          return;
        }
        sendToExtension({ type: 'apply-feature-edit', spec });
        res.json({ success: true, preview: statement });
      } catch (err: any) {
        res.status(500).json({ success: false, reason: err?.message ?? String(err) });
      }
      return;
    }

    // Extrude takes no pick selection — its profile is a sketch statement.
    // The transform re-verifies that the line holds a sketch() call.
    if (feature === 'extrude') {
      const request = validateExtrude(req.body);
      if ('error' in request) {
        res.status(400).json({ error: request.error });
        return;
      }
      try {
        const options: ExtrudeEditOptions = {
          op: request.op,
          distance: request.distance,
          distance2: request.distance2,
          symmetric: request.symmetric,
          draft: request.draft,
          drill: request.drill,
          thin: request.thin,
          profile: request.profile.mode === 'bound' ? 'bound' : 'implicit',
        };
        // Truthful preview name for a bound profile: the same resolution the
        // transform runs (reused const, collision-suffixed hint).
        let profileVar: string | null = null;
        if (request.profile.mode === 'bound') {
          const code = fluidCadServer.getCurrentCode();
          if (code) {
            const namer = await makeProducerNamer(code);
            profileVar = namer([{ line: request.profile.line, nameHint: 's', featureType: 'sketch' }])[0];
          }
        }
        const statement = renderExtrudeStatement(options, profileVar);
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
            producers: [{
              line: request.profile.line,
              column: request.profile.column,
              featureType: 'sketch',
              nameHint: 's',
              bind: request.profile.mode === 'bound',
            }],
            parts: [],
            imports: [],
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

    // A pick-less sketch: no face selector — a sketch on an origin plane,
    // appended after the file's last statement. No synthesis is involved;
    // `plane` picks the target ('xy'/'xz'/'yz'), absent defaults to xy.
    if (feature === 'sketch' && Array.isArray(req.body?.entities) && req.body.entities.length === 0) {
      const plane = req.body?.plane;
      if (plane !== undefined && plane !== 'xy' && plane !== 'xz' && plane !== 'yz') {
        res.status(400).json({ error: 'plane must be "xy", "xz" or "yz"' });
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
      res.status(400).json({ error: 'feature must be "fillet", "chamfer", "shell", "sketch", "extrude", "sweep" or "loft"' });
      return;
    }
    // Per-feature numeric parameter: fillet/chamfer need a positive radius or
    // distance; shell needs a nonzero thickness (negative is the idiom —
    // shell(-2, …) hollows inward); sketch has no numeric parameter at all.
    if (feature === 'shell') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
        res.status(400).json({ error: 'value must be a nonzero number (negative hollows inward)' });
        return;
      }
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
      if (preview === true) {
        res.json({
          success: true,
          preview: synthesis.preview,
          args: synthesis.args,
          alternatives: synthesis.alternatives,
        });
        return;
      }
      const spec = typeof selectorOverride === 'string' && selectorOverride.trim() !== synthesis.args
        ? { ...synthesis.spec, rawArgs: selectorOverride.trim() }
        : synthesis.spec;
      sendToExtension({ type: 'apply-feature-edit', spec });
      res.json({ success: true, preview: synthesis.preview });
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
    if (callee !== undefined && callee !== 'sketch' && callee !== 'plane') {
      res.status(400).json({ error: 'callee must be "sketch" or "plane"' });
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

  // The single-pick selection queries share a shape: validate the pick, run
  // a read-only query against the last render, surface not-ok reasons as 422.
  const selectionQueryRoute = (
    path: string,
    run: (pick: Pick) => any,
    project: (result: any) => unknown,
  ): void => {
    router.post(path, (req, res) => {
      const pick = validatePick(req.body?.entity);
      if (!pick) {
        res.status(400).json({ error: 'entity must be a {shapeId, sub:{type, index}} pick' });
        return;
      }
      try {
        const result = run(pick);
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

  // Expand a picked edge/face to its tangent chain on the owning solid —
  // the "Select with tangents" gesture.
  selectionQueryRoute('/selection/expand-tangents',
    pick => fluidCadServer.expandTangentChain(pick),
    result => ({ members: result.members }));

  // Expand a picked edge/face to its whole classified bucket — the
  // double-click gesture.
  selectionQueryRoute('/selection/expand-bucket',
    pick => fluidCadServer.expandBucket(pick),
    result => ({ members: result.members }));

  // Every multi-select group a pick can expand to (the right-click menu):
  // tangent chain, classified bucket, same-type and equal-measure edges.
  selectionQueryRoute('/selection/groups',
    pick => fluidCadServer.listSelectionGroups(pick),
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
