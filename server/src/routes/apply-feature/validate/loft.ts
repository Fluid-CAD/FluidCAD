// loft request validation: profiles, guides, conditions and connections (create and edit).

import type { FluidCadServer, SelectionBoundary } from '../../../fluidcad-server.ts';
import {
  extractNumericParams,
  makeProducerBindable,
  makeProducerNamer,
  resolveParamValues,
  validValueExpr,
  type LoftConnectionSpec,
  type LoftPointSpec,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { normalizePath } from '../../../normalize-path.ts';
import { validateScopeLocs, validateSketchLoc, type SketchLoc } from '../locations.ts';
import { validatePick, type Pick, type VertexPick } from '../picks.ts';
import { makeProducerMerger } from '../synthesis.ts';
import { validateThinOffsets } from './common.ts';

/** Ordered loft profile inputs: sketches and picked faces, mixed freely. */
type LoftProfileInput = ({ kind: 'sketch' } & SketchLoc) | { kind: 'face'; pick: Pick };

type LoftCondition = { type: 'normal' | 'tangent'; magnitude: ValueExpr };

type LoftRequest = {
  op: 'add' | 'remove' | 'new';
  thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
  profiles: LoftProfileInput[];
  connections?: LoftConnectionInput[];
  guides: SketchLoc[];
  startCondition: LoftCondition | null;
  endCondition: LoftCondition | null;
  /** Solid statements the boolean is scoped to; empty writes no `.scope(…)`. */
  scope: SketchLoc[];
};

const MAX_LOFT_PROFILES = 16;

/** Each picked vertex costs a full point synthesis; far above any real loft. */
const MAX_LOFT_CONNECTIONS = 64;

/**
 * What a connection point must sit on to belong to profile k, as far as the
 * request can tell: a sketch by its statement line, a face pick by its shape.
 * Null when the profile rides as kept source text — the build still checks it.
 */
type LoftProfileOwner = { kind: 'sketch'; line: number } | { kind: 'shape'; shapeId: string } | null;

export function loftProfileOwners(
  profiles: ({ kind: 'verbatim' } | ({ kind: 'sketch' } & SketchLoc) | { kind: 'face'; pick: Pick })[] | undefined,
): LoftProfileOwner[] | undefined {
  return profiles?.map(profile => {
    if (profile.kind === 'sketch') {
      return { kind: 'sketch', line: profile.line };
    }
    if (profile.kind === 'face') {
      return { kind: 'shape', shapeId: profile.pick.shapeId };
    }
    return null;
  });
}

/** Clean connection rows: retained source text or newly picked topology vertices. */
export type LoftConnectionInput =
  | { kind: 'verbatim'; sourceIndex: number }
  | { kind: 'points'; points: (
    { kind: 'vertex'; pick: VertexPick }
    | { kind: 'verbatim'; sourceIndex: number; pointIndex: number }
  )[] };

export function validateLoftConnections(raw: unknown, edit: boolean, profileCount?: number):
  { connections: LoftConnectionInput[] | undefined } | { error: string } {
  if (raw === undefined) {
    return { connections: undefined };
  }
  if (!Array.isArray(raw)) {
    return { error: 'connections must be a list of point rows' };
  }
  if (raw.length > MAX_LOFT_CONNECTIONS) {
    return { error: `a loft takes at most ${MAX_LOFT_CONNECTIONS} connections` };
  }
  const connections: LoftConnectionInput[] = [];
  const validIndex = (index: unknown): index is number => Number.isInteger(index) && (index as number) >= 0;
  for (const row of raw) {
    if (edit && row?.kind === 'verbatim' && validIndex(row.sourceIndex)) {
      connections.push({ kind: 'verbatim', sourceIndex: row.sourceIndex });
      continue;
    }
    if (row?.kind !== 'points' || !Array.isArray(row.points)
      || row.points.length < 2 || row.points.length > MAX_LOFT_PROFILES
      || (profileCount !== undefined && row.points.length !== profileCount)) {
      return { error: 'each connection needs one point per loft profile' };
    }
    const points: Extract<LoftConnectionInput, { kind: 'points' }>['points'] = [];
    for (const point of row.points) {
      if (edit && point?.kind === 'verbatim' && validIndex(point.sourceIndex) && validIndex(point.pointIndex)) {
        points.push({ kind: 'verbatim', sourceIndex: point.sourceIndex, pointIndex: point.pointIndex });
        continue;
      }
      const pick = point?.kind === 'vertex' ? validatePick(point.entity, 'vertex') : null;
      if (!pick) {
        return { error: 'a connection point must carry a {shapeId, sub:{type:"vertex", index}} pick' };
      }
      points.push({ kind: 'vertex', pick });
    }
    connections.push({ kind: 'points', points });
  }
  return { connections };
}

/** Reuse the stage-4 point synthesis and remap its producers into the loft's existing merger. */
export async function synthesizeLoftConnections(
  server: FluidCadServer,
  rows: LoftConnectionInput[] | undefined,
  filePath: string,
  merge: ReturnType<typeof makeProducerMerger>['merge'],
  scopeLocation: { filePath: string; line: number; column?: number },
  owners: LoftProfileOwner[] | undefined,
  before?: SelectionBoundary,
): Promise<{ connections: LoftConnectionSpec[] | undefined; imports: string[] } | { error: string }> {
  if (rows === undefined) {
    return { connections: undefined, imports: [] };
  }
  // Every picked vertex with its place in the request: connection row, profile slot.
  const picked = rows.flatMap((row, connection) => row.kind === 'points'
    ? row.points.flatMap((point, profile) => point.kind === 'vertex' ? [{ pick: point.pick, connection, profile }] : [])
    : []);
  const picks = picked.map(entry => entry.pick);
  const points: LoftPointSpec[] = [];
  const imports: string[] = [];
  if (picks.length > 0) {
    const code = server.getCurrentCode();
    if (!code) {
      return { error: 'no current source buffer is available for connection points' };
    }
    const scope = server.resolveStatementPart(scopeLocation);
    const resolved = server.resolveSelection({ picks, ...(before ? { before: before.index } : {}),
      ...(scope ? { scope: { part: scope.partName } } : {}) }, {
      namer: await makeProducerNamer(code), bindable: await makeProducerBindable(code),
      params: resolveParamValues(await extractNumericParams(code), server.getParamDefinitions()),
    });
    if (resolved.ok === false) {
      return { error: resolved.reason };
    }
    if (resolved.matches.some(match => match.part !== (scope?.partName ?? null))) {
      return { error: 'connection points must live in the loft’s part() scope' };
    }
    const synthesis = resolved.synthesized;
    if (!synthesis?.ok) {
      return { error: synthesis && synthesis.ok === false ? synthesis.reason : 'the workspace kernel cannot synthesize connection points' };
    }
    const remap = new Map<string, number>();
    for (const producer of synthesis.producers) {
      if (!producer.filePath || normalizePath(producer.filePath) !== normalizePath(filePath) || producer.line === null) {
        return { error: 'connection points must be authored in the loft’s file' };
      }
      remap.set(producer.sceneObjectId, merge({ line: producer.line, column: producer.column ?? 0,
        featureType: producer.featureType, nameHint: producer.variable, bind: true }));
    }
    for (const [i, part] of synthesis.parts.entries()) {
      // A row is positional: point k must be a vertex of profile k. The build
      // would refuse it too ("off its profile") — refuse before writing code.
      const { connection, profile, pick } = picked[i] ?? {};
      const owner = profile === undefined ? null : owners?.[profile] ?? null;
      const onProfile = owner === null
        || (owner.kind === 'shape' && pick!.shapeId === owner.shapeId)
        || (owner.kind === 'sketch' && part.point?.kind === 'sketch'
          && synthesis.producers.find(producer => producer.sceneObjectId === part.producer)?.line === owner.line);
      if (!onProfile) {
        return { error: `connection ${connection! + 1}: point ${profile! + 1} is not a vertex of profile ${profile! + 1} — pick one vertex on each profile, in profile order` };
      }
      if (part.point?.kind === 'sketch' && part.producer !== null && remap.has(part.producer)) {
        points.push({ kind: 'sketch', producer: remap.get(part.producer)!, target: part.point.target });
      } else if (part.point?.kind === 'edge') {
        const refs = part.point.refs.map(id => remap.get(id)!);
        points.push({ kind: 'edge', role: part.point.role, selector: {
          producer: part.producer === null ? null : remap.get(part.producer)!, accessor: part.accessor,
          indices: part.point.indices, filterArgs: part.point.filterArgs, refs,
        } });
      } else {
        return { error: 'a connection point has no source expression' };
      }
    }
    if (points.length !== picks.length) {
      return { error: 'each picked connection vertex must resolve to one point expression' };
    }
    imports.push(...synthesis.imports);
  }
  let index = 0;
  return { connections: rows.map(row => row.kind === 'verbatim' ? row : {
    kind: 'points', points: row.points.map(point => point.kind === 'vertex' ? points[index++] : point),
  }), imports };
}

/**
 * One `.startCondition()`/`.endCondition()` request field: absent/null means
 * no chain ('none' never reaches the wire — it only clears the dialog field).
 */
export function validateLoftCondition(
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
export function validateLoft(body: any): LoftRequest | { error: string } {
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
  const scopeResult = validateScopeLocs(body, op);
  if ('error' in scopeResult) {
    return scopeResult;
  }
  const connections = validateLoftConnections(body.connections, false, result.length);
  if ('error' in connections) {
    return connections;
  }
  return {
    op, thin: thinResult.offsets, profiles: result, guides: guideLocs,
    startCondition: startResult.condition, endCondition: endResult.condition,
    scope: scopeResult.scope,
    connections: connections.connections,
  };
}

/** One edited loft profile as the request carries it. */
export type EditLoftProfileInput =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'sketch' } & SketchLoc)
  | { kind: 'face'; pick: Pick };

/** One edited loft guide as the request carries it. */
export type EditLoftGuideInput =
  | { kind: 'verbatim'; sourceIndex: number }
  | ({ kind: 'sketch' } & SketchLoc);

/** The edited loft profile list: verbatim keeps, sketch refs, face picks. */
export function validateEditLoftProfiles(
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
export function validateEditLoftGuides(
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
