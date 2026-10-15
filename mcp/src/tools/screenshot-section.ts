// A capture's section (cut-away) view and its input check, shared by the
// screenshot tools and `measure`'s image. Mirrors the server's
// SectionRequests, which resolves the model's own planes (a face, a
// plane()/section() statement) to origin and normal before the page's
// SectionPlaneMath (ui/src/scene/section-spec.ts) owns the math.

import { SelectionInputs } from './inspection.ts';

export const SECTION_PLANE_NAMES = ['xy', 'yz', 'xz'] as const;
export type SectionPlaneName = (typeof SECTION_PLANE_NAMES)[number];

type Vec3 = [number, number, number];

/**
 * The cut plane: a world datum plane, an explicit `{ origin, normal }`, a
 * planar face (by index, or a filter matching exactly one), or a `plane()`
 * / `section()` statement by scene-object id.
 */
export type SectionPlaneInput =
  | SectionPlaneName
  | { origin: Vec3; normal: Vec3 }
  | { sceneObjectId: string }
  | { shapeId: string; kind?: 'face'; index: number; instanceId?: string }
  | { expression: string; scope?: { sceneObjectId: string } | { part: string } | { instanceId: string } };

/**
 * Document units. The normal points at the half that is removed: a section
 * on `xy` removes everything above z = offset. `offset` moves the plane
 * along its normal; `flip` keeps the other half.
 */
export type SectionSpec = {
  plane: SectionPlaneInput;
  offset?: number;
  flip?: boolean;
};

export class ScreenshotSections {

  /** The parsed section, or an error message naming the field under `label`. */
  static validate(raw: unknown, label = '`section`'): SectionSpec | string {
    const field = (name: string): string => `${label.slice(0, -1)}.${name}\``;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return `${label} must be an object { plane, offset?, flip? }.`;
    }
    const s = raw as Record<string, unknown>;
    const plane = ScreenshotSections.plane(s.plane, field('plane'));
    if ('error' in plane) {
      return plane.error;
    }
    const spec: SectionSpec = { plane: plane.plane };
    if (s.offset !== undefined) {
      if (typeof s.offset !== 'number' || !Number.isFinite(s.offset)) {
        return `${field('offset')} must be a finite number (document units) when provided.`;
      }
      spec.offset = s.offset;
    }
    if (s.flip !== undefined) {
      if (typeof s.flip !== 'boolean') {
        return `${field('flip')} must be a boolean when provided.`;
      }
      spec.flip = s.flip;
    }
    return spec;
  }

  /** A plane name is itself a valid string, so errors travel in an object. */
  private static plane(raw: unknown, label: string): { plane: SectionPlaneInput } | { error: string } {
    const choices = `${label} must be one of ${SECTION_PLANE_NAMES.join(', ')}, an explicit { origin, normal }, `
      + 'a planar face { shapeId, kind: "face", index, instanceId? } or { expression, scope? }, or a plane()/section() statement { sceneObjectId }.';
    const field = (name: string): string => `${label.slice(0, -1)}.${name}\``;
    if (typeof raw === 'string') {
      if (!(SECTION_PLANE_NAMES as readonly string[]).includes(raw)) {
        return { error: choices };
      }
      return { plane: raw as SectionPlaneName };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: choices };
    }
    const p = raw as Record<string, unknown>;
    if ('origin' in p || 'normal' in p) {
      if (!ScreenshotSections.isVec3(p.origin)) {
        return { error: `${field('origin')} must be a 3-element array of finite numbers (document units).` };
      }
      if (!ScreenshotSections.isVec3(p.normal)) {
        return { error: `${field('normal')} must be a 3-element array of finite numbers.` };
      }
      if (p.normal.every((n) => n === 0)) {
        return { error: `${field('normal')} must not be the zero vector.` };
      }
      return { plane: { origin: [...p.origin], normal: [...p.normal] } };
    }
    if ('sceneObjectId' in p) {
      if (typeof p.sceneObjectId !== 'string' || p.sceneObjectId.length === 0) {
        return { error: `${field('sceneObjectId')} must be a non-empty scene-object id of a plane() or section() statement (ids come from get_scene_summary).` };
      }
      return { plane: { sceneObjectId: p.sceneObjectId } };
    }
    if ('expression' in p) {
      const problem = SelectionInputs.expressionError(p.expression, field('expression'))
        ?? SelectionInputs.scopeError(p.scope, field('scope'));
      if (problem) {
        return { error: problem };
      }
      return { plane: { expression: p.expression as string, ...(p.scope !== undefined ? { scope: p.scope as never } : {}) } };
    }
    if ('shapeId' in p || 'index' in p) {
      if (typeof p.shapeId !== 'string' || p.shapeId.length === 0) {
        return { error: `${field('shapeId')} must be a non-empty shape id (ids come from list_shapes or get_scene_summary).` };
      }
      if (p.kind !== undefined && p.kind !== 'face') {
        return { error: `${field('kind')} must be "face": only a planar face gives a section plane.` };
      }
      if (typeof p.index !== 'number' || !Number.isInteger(p.index) || p.index < 0) {
        return { error: `${field('index')} must be a non-negative face index.` };
      }
      if (p.instanceId !== undefined && (typeof p.instanceId !== 'string' || p.instanceId.length === 0)) {
        return { error: `${field('instanceId')} must be a non-empty string when given.` };
      }
      return {
        plane: {
          shapeId: p.shapeId,
          kind: 'face',
          index: p.index,
          ...(p.instanceId !== undefined ? { instanceId: p.instanceId as string } : {}),
        },
      };
    }
    return { error: choices };
  }

  private static isVec3(value: unknown): value is Vec3 {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
}
