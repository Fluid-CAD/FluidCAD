import type { SectionPlaneName, SectionSpec } from '../ws-protocol.ts';

/**
 * Body validation for a capture's `section`, returning the exact
 * {@link SectionSpec} the `take-screenshot` message carries or an error
 * message naming the field. Mirrors `SectionPlaneMath.validate` in
 * ui/src/scene/section-spec.ts: the page owns the math, the server only
 * checks the shape.
 */
export class SectionRequests {

  static readonly PLANE_NAMES: readonly SectionPlaneName[] = ['xy', 'yz', 'xz'];

  static validate(raw: unknown, label = 'section'): SectionSpec | string {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return `${label} must be an object { plane, offset?, flip? }.`;
    }
    const s = raw as Record<string, unknown>;
    const plane = SectionRequests.plane(s.plane, `${label}.plane`);
    if ('error' in plane) {
      return plane.error;
    }
    const spec: SectionSpec = { plane: plane.plane };
    if (s.offset !== undefined) {
      if (typeof s.offset !== 'number' || !Number.isFinite(s.offset)) {
        return `${label}.offset must be a finite number (document units) when provided.`;
      }
      spec.offset = s.offset;
    }
    if (s.flip !== undefined) {
      if (typeof s.flip !== 'boolean') {
        return `${label}.flip must be a boolean when provided.`;
      }
      spec.flip = s.flip;
    }
    return spec;
  }

  /** A plane name is itself a valid string, so errors travel in an object. */
  private static plane(raw: unknown, label: string): { plane: SectionSpec['plane'] } | { error: string } {
    const choices = `${label} must be one of ${SectionRequests.PLANE_NAMES.join(', ')} or an object { origin, normal }.`;
    if (typeof raw === 'string') {
      if (!(SectionRequests.PLANE_NAMES as readonly string[]).includes(raw)) {
        return { error: choices };
      }
      return { plane: raw as SectionPlaneName };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: choices };
    }
    const p = raw as Record<string, unknown>;
    if (!SectionRequests.isVec3(p.origin)) {
      return { error: `${label}.origin must be a 3-element array of finite numbers (document units).` };
    }
    if (!SectionRequests.isVec3(p.normal)) {
      return { error: `${label}.normal must be a 3-element array of finite numbers.` };
    }
    if (p.normal.every((n) => n === 0)) {
      return { error: `${label}.normal must not be the zero vector.` };
    }
    return { plane: { origin: [...p.origin], normal: [...p.normal] } };
  }

  private static isVec3(value: unknown): value is [number, number, number] {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
}
