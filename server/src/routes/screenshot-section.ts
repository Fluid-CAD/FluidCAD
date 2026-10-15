import type { SectionPlaneName, SectionSpec } from '../ws-protocol.ts';
import type { ResolveSelectionRequest, ResolveSelectionResult, ResolvedSelectionMatch } from '../../../lib/dist/index.js';
import type { SceneSummaryObject } from '../fluidcad-server/scene-summary.ts';
import { SelectionRequests } from './selection-requests.ts';

type Vec3 = [number, number, number];

/** A planar face as a section plane, addressed the way `measure` addresses entities. */
export type SectionFaceRef = { shapeId: string; kind?: 'face'; index: number; instanceId?: string };
/** A filter expression that must match exactly one planar face. */
export type SectionFaceFilter = { expression: string; scope?: unknown };
/** A `plane()` or `section()` statement, by its scene-object id. */
export type SectionSceneObjectRef = { sceneObjectId: string };

/**
 * The plane a capture's `section` may name: a datum plane or an explicit
 * `{ origin, normal }` (what the page clips at), or one of the model's own
 * planes — a planar face by index or filter, or a `plane()` / `section()`
 * statement by id — which the server reads into origin and normal here.
 */
export type SectionPlaneRequest =
  | SectionPlaneName
  | { origin: Vec3; normal: Vec3 }
  | SectionSceneObjectRef
  | SectionFaceRef
  | SectionFaceFilter;

/** The selection resolver a face plane goes through — `FluidCadServer.resolveSelection`, picks included. */
export type SectionSelectionResolver = (request: ResolveSelectionRequest) => ResolveSelectionResult | { ok: false; code: 'no-scene' | 'unsupported'; reason: string };
/** A scene object of the current render by id (`getSceneSummary().objects`), or null. */
export type SectionSceneObjectLookup = (id: string) => SceneSummaryObject | null;

export type SectionResolvers = {
  resolveSelection?: SectionSelectionResolver;
  sceneObject?: SectionSceneObjectLookup;
};

export type SectionResolution =
  | { ok: true; section: SectionSpec }
  | { ok: false; status: number; error: string; code?: string; candidates?: unknown[] };

/**
 * Body validation and resolution of a capture's `section`: the plane forms
 * the page cannot read (a face, a `plane()` or `section()` statement) are
 * resolved to `{ origin, normal }` here, so the `take-screenshot` message
 * only ever carries the exact {@link SectionSpec} the page's
 * `SectionPlaneMath` (ui/src/scene/section-spec.ts) owns the math for.
 *
 * A face's plane is the face's own: its outward normal points away from the
 * solid, so a bare face section removes the outside and shows the face
 * uncut — `offset` moves the cut into the part (a negative offset, along
 * the normal) and `flip` keeps the outside instead. A `section()` statement
 * resolves to its saved cut, its own offset applied and its flip carried
 * as the default; the request's `offset` moves that cut further and its
 * `flip` overrides.
 */
export class SectionRequests {

  static readonly PLANE_NAMES: readonly SectionPlaneName[] = ['xy', 'yz', 'xz'];

  /** The resolved section, or a refusal naming the field under `label`. */
  static resolve(raw: unknown, resolvers: SectionResolvers = {}, label = 'section'): SectionResolution {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return SectionRequests.refuse(400, `${label} must be an object { plane, offset?, flip? }.`);
    }
    const s = raw as Record<string, unknown>;
    if (s.offset !== undefined && (typeof s.offset !== 'number' || !Number.isFinite(s.offset))) {
      return SectionRequests.refuse(400, `${label}.offset must be a finite number (document units) when provided.`);
    }
    if (s.flip !== undefined && typeof s.flip !== 'boolean') {
      return SectionRequests.refuse(400, `${label}.flip must be a boolean when provided.`);
    }
    const plane = SectionRequests.plane(s.plane, `${label}.plane`, resolvers);
    if (plane.ok === false) {
      return plane;
    }
    const spec: SectionSpec = { plane: plane.plane };
    const offset = (s.offset as number | undefined ?? 0) + (plane.offset ?? 0);
    if (offset !== 0) {
      spec.offset = offset;
    }
    const flip = (s.flip as boolean | undefined) ?? plane.flip;
    if (flip !== undefined) {
      spec.flip = flip;
    }
    return { ok: true, section: spec };
  }

  /** Whether the plane is one the page can clip at as given (a datum name or origin + normal). */
  static isLiteralPlane(plane: unknown): plane is SectionSpec['plane'] {
    if (typeof plane === 'string') {
      return (SectionRequests.PLANE_NAMES as readonly string[]).includes(plane);
    }
    return SectionRequests.isObject(plane) && 'origin' in plane && 'normal' in plane;
  }

  private static plane(
    raw: unknown,
    label: string,
    resolvers: SectionResolvers,
  ): { ok: true; plane: SectionSpec['plane']; offset?: number; flip?: boolean } | Extract<SectionResolution, { ok: false }> {
    const choices = `${label} must be one of ${SectionRequests.PLANE_NAMES.join(', ')}, an explicit { origin, normal }, `
      + 'a planar face { shapeId, kind: "face", index, instanceId? } or { expression, scope? }, or a plane()/section() statement { sceneObjectId }.';
    if (typeof raw === 'string') {
      if (!(SectionRequests.PLANE_NAMES as readonly string[]).includes(raw)) {
        return SectionRequests.refuse(400, choices);
      }
      return { ok: true, plane: raw as SectionPlaneName };
    }
    if (!SectionRequests.isObject(raw)) {
      return SectionRequests.refuse(400, choices);
    }
    if ('origin' in raw || 'normal' in raw) {
      return SectionRequests.explicit(raw, label);
    }
    if ('sceneObjectId' in raw) {
      return SectionRequests.sceneObject(raw, label, resolvers.sceneObject);
    }
    if ('expression' in raw) {
      return SectionRequests.faceFilter(raw, label, resolvers.resolveSelection);
    }
    if ('shapeId' in raw || 'index' in raw) {
      return SectionRequests.faceRef(raw, label, resolvers.resolveSelection);
    }
    return SectionRequests.refuse(400, choices);
  }

  private static explicit(p: Record<string, unknown>, label: string): { ok: true; plane: SectionSpec['plane'] } | Extract<SectionResolution, { ok: false }> {
    if (!SectionRequests.isVec3(p.origin)) {
      return SectionRequests.refuse(400, `${label}.origin must be a 3-element array of finite numbers (document units).`);
    }
    if (!SectionRequests.isVec3(p.normal)) {
      return SectionRequests.refuse(400, `${label}.normal must be a 3-element array of finite numbers.`);
    }
    if (p.normal.every((n) => n === 0)) {
      return SectionRequests.refuse(400, `${label}.normal must not be the zero vector.`);
    }
    return { ok: true, plane: { origin: [...p.origin], normal: [...p.normal] } };
  }

  // ---------------------------------------------------------------------------
  // A plane() or section() statement
  // ---------------------------------------------------------------------------

  /**
   * The plane a statement built: a `plane()` row serializes its origin and
   * normal as points, a `section()` row as triples with its own offset and
   * flip. Either way the row must have built — a failed plane carries no
   * numbers worth cutting at.
   */
  private static sceneObject(
    p: Record<string, unknown>,
    label: string,
    lookup: SectionSceneObjectLookup | undefined,
  ): { ok: true; plane: SectionSpec['plane']; offset?: number; flip?: boolean } | Extract<SectionResolution, { ok: false }> {
    if (typeof p.sceneObjectId !== 'string' || p.sceneObjectId.length === 0) {
      return SectionRequests.refuse(400, `${label}.sceneObjectId must be a non-empty scene-object id (ids come from get_scene_summary).`);
    }
    if (!lookup) {
      return SectionRequests.refuse(501, `${label}.sceneObjectId cannot be resolved on this server.`);
    }
    const object = lookup(p.sceneObjectId);
    if (!object) {
      return { ok: false, status: 404, code: 'no-match', error: `${label}.sceneObjectId: no scene object "${p.sceneObjectId}" in the current render (ids come from get_scene_summary).` };
    }
    const what = `${object.kind} "${object.name}" (${object.id})`;
    if (object.hasError) {
      return { ok: false, status: 422, code: 'not-a-plane', error: `${label}.sceneObjectId: ${what} did not build${object.errorMessage ? `: ${object.errorMessage}` : ''}; it has no plane to cut at.` };
    }
    const params = SectionRequests.isObject(object.params) ? object.params : {};
    const origin = SectionRequests.toVec3(params.origin);
    const normal = SectionRequests.toVec3(params.normal);
    if (!origin || !normal || normal.every((n) => n === 0)) {
      return { ok: false, status: 422, code: 'not-a-plane', error: `${label}.sceneObjectId: ${what} carries no plane; pass the id of a plane() or section() statement, or a planar face.` };
    }
    const out: { ok: true; plane: SectionSpec['plane']; offset?: number; flip?: boolean } = { ok: true, plane: { origin, normal } };
    if (object.kind === 'section') {
      if (typeof params.offset === 'number' && Number.isFinite(params.offset) && params.offset !== 0) {
        out.offset = params.offset;
      }
      if (params.flip === true) {
        out.flip = true;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // A planar face
  // ---------------------------------------------------------------------------

  private static faceRef(
    p: Record<string, unknown>,
    label: string,
    resolveSelection: SectionSelectionResolver | undefined,
  ): { ok: true; plane: SectionSpec['plane'] } | Extract<SectionResolution, { ok: false }> {
    if (typeof p.shapeId !== 'string' || p.shapeId.length === 0) {
      return SectionRequests.refuse(400, `${label}.shapeId must be a non-empty shape id (ids come from list_shapes or get_scene_summary).`);
    }
    if (p.kind !== undefined && p.kind !== 'face') {
      return SectionRequests.refuse(400, `${label}.kind must be "face": only a planar face gives a section plane.`);
    }
    if (!Number.isInteger(p.index) || (p.index as number) < 0) {
      return SectionRequests.refuse(400, `${label}.index must be a non-negative face index.`);
    }
    if (p.instanceId !== undefined && (typeof p.instanceId !== 'string' || p.instanceId.length === 0)) {
      return SectionRequests.refuse(400, `${label}.instanceId must be a non-empty string when provided.`);
    }
    if (!resolveSelection) {
      return SectionRequests.refuse(501, `${label}: face planes cannot be resolved on this server.`);
    }
    const result = resolveSelection({
      picks: [{ shapeId: p.shapeId, sub: { type: 'face', index: p.index as number } }],
      ...(p.instanceId !== undefined ? { scope: { instanceId: p.instanceId as string } } : {}),
    });
    if (result.ok === false) {
      return { ok: false, status: SelectionRequests.statusFor(result.code), code: result.code, error: `${label}: ${result.reason}` };
    }
    const match = result.matches[0];
    if (!match) {
      return { ok: false, status: 404, code: 'no-match', error: `${label}: face ${p.index} of "${p.shapeId}" was not found.` };
    }
    return SectionRequests.facePlane(match, label, `face ${p.index} of "${p.shapeId}"`);
  }

  private static faceFilter(
    p: Record<string, unknown>,
    label: string,
    resolveSelection: SectionSelectionResolver | undefined,
  ): { ok: true; plane: SectionSpec['plane'] } | Extract<SectionResolution, { ok: false }> {
    const problem = SelectionRequests.expressionError(p.expression, `${label}.expression`)
      ?? SelectionRequests.scopeError(p.scope, `${label}.scope`);
    if (problem) {
      return SectionRequests.refuse(400, problem);
    }
    if (!resolveSelection) {
      return SectionRequests.refuse(501, `${label}: face planes cannot be resolved on this server.`);
    }
    const expression = p.expression as string;
    const result = resolveSelection({ expression, ...(p.scope !== undefined ? { scope: p.scope as never } : {}) });
    if (result.ok === false) {
      const candidates = 'candidates' in result ? (result.candidates as unknown[]) : undefined;
      return { ok: false, status: SelectionRequests.statusFor(result.code), code: result.code, error: `${label}: ${result.reason}`, ...(candidates ? { candidates } : {}) };
    }
    if (result.count === 0) {
      return { ok: false, status: 404, code: 'no-match', error: `${label}: ${expression} matches nothing.` };
    }
    if (result.matches.length > 1) {
      return {
        ok: false,
        status: 409,
        code: 'ambiguous-match',
        error: `${label}: ${expression} matches ${result.matches.length} entities; a section plane needs exactly one planar face (candidates listed).`,
        candidates: result.matches,
      };
    }
    return SectionRequests.facePlane(result.matches[0], label, expression);
  }

  /** The plane of a resolved match: its summary's centre and normal, when it is a planar face. */
  private static facePlane(
    match: ResolvedSelectionMatch,
    label: string,
    what: string,
  ): { ok: true; plane: SectionSpec['plane'] } | Extract<SectionResolution, { ok: false }> {
    const summary = match.summary as { form?: string; center?: unknown; normal?: unknown } | undefined;
    if (match.kind !== 'face') {
      return { ok: false, status: 422, code: 'not-planar', error: `${label}: ${what} is ${SectionRequests.article(match.kind)}, not a face; a section plane needs a planar face.` };
    }
    const origin = SectionRequests.toVec3(summary?.center);
    const normal = SectionRequests.toVec3(summary?.normal);
    if (summary?.form !== 'plane' || !origin || !normal) {
      return { ok: false, status: 422, code: 'not-planar', error: `${label}: ${what} is a ${summary?.form ?? 'face'} face, not planar; a section plane needs a planar face.` };
    }
    return { ok: true, plane: { origin, normal } };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private static article(kind: string): string {
    return /^[aeiou]/i.test(kind) ? `an ${kind}` : `a ${kind}`;
  }

  private static refuse(status: number, error: string): Extract<SectionResolution, { ok: false }> {
    return { ok: false, status, error };
  }

  private static isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private static isVec3(value: unknown): value is Vec3 {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  }

  /** A triple from either spelling a scene object uses: `[x, y, z]` or `{ x, y, z }`. */
  private static toVec3(value: unknown): Vec3 | null {
    if (SectionRequests.isVec3(value)) {
      return [...value];
    }
    if (SectionRequests.isObject(value)) {
      const { x, y, z } = value;
      if ([x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return [x as number, y as number, z as number];
      }
    }
    return null;
  }
}
