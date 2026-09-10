// A capture's section (cut-away) view and its input check, shared by the
// screenshot tools and `measure`'s image. Mirrors the server's
// SectionRequests and the page's SectionPlaneMath (ui/src/scene/section-spec.ts),
// which owns the math.

export const SECTION_PLANE_NAMES = ['xy', 'yz', 'xz'] as const;
export type SectionPlaneName = (typeof SECTION_PLANE_NAMES)[number];

/**
 * Document units. The normal points at the half that is removed: a section
 * on `xy` removes everything above z = offset. `offset` moves the plane
 * along its normal; `flip` keeps the other half.
 */
export type SectionSpec = {
  plane: SectionPlaneName | { origin: [number, number, number]; normal: [number, number, number] };
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
  private static plane(raw: unknown, label: string): { plane: SectionSpec['plane'] } | { error: string } {
    const choices = `${label} must be one of ${SECTION_PLANE_NAMES.join(', ')} or an object { origin, normal }.`;
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

  private static isVec3(value: unknown): value is [number, number, number] {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  }
}
