// The stateless camera views a capture can ask for, and their input check —
// shared by the screenshot tools and `measure`'s image.

export const NAMED_VIEWS = [
  'front', 'back', 'left', 'right', 'top', 'bottom',
  'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
  'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
] as const;
export type NamedView = (typeof NAMED_VIEWS)[number];

export type ScreenshotView =
  | { kind: 'current' }
  | { kind: 'named'; name: NamedView }
  | { kind: 'orbit-from-current'; azimuthDeg: number; elevationDeg: number }
  | { kind: 'look-from'; eye: [number, number, number]; target?: [number, number, number] };

export class ScreenshotViews {

  static readonly MIN_MULTI = 2;
  static readonly MAX_MULTI = 6;

  /** The parsed view, or an error message naming the field under `label`. */
  static validate(raw: unknown, label = '`view`'): ScreenshotView | string {
    if (raw === null || typeof raw !== 'object') {
      return `${label} must be an object.`;
    }
    const v = raw as Record<string, unknown>;
    const field = (name: string): string => `${label.slice(0, -1)}.${name}\``;
    switch (v.kind) {
      case 'current':
        return { kind: 'current' };
      case 'named': {
        if (typeof v.name !== 'string' || !NAMED_VIEWS.includes(v.name as NamedView)) {
          return `${field('name')} must be one of: ${NAMED_VIEWS.join(', ')}.`;
        }
        return { kind: 'named', name: v.name as NamedView };
      }
      case 'orbit-from-current': {
        if (typeof v.azimuthDeg !== 'number' || !Number.isFinite(v.azimuthDeg)) {
          return `${field('azimuthDeg')} must be a finite number.`;
        }
        if (typeof v.elevationDeg !== 'number' || !Number.isFinite(v.elevationDeg)) {
          return `${field('elevationDeg')} must be a finite number.`;
        }
        return { kind: 'orbit-from-current', azimuthDeg: v.azimuthDeg, elevationDeg: v.elevationDeg };
      }
      case 'look-from': {
        if (!ScreenshotViews.isVec3(v.eye)) {
          return `${field('eye')} must be a 3-element array of finite numbers.`;
        }
        if (v.target !== undefined && !ScreenshotViews.isVec3(v.target)) {
          return `${field('target')} must be a 3-element array of finite numbers when provided.`;
        }
        return {
          kind: 'look-from',
          eye: v.eye as [number, number, number],
          target: v.target as [number, number, number] | undefined,
        };
      }
      default:
        return `${field('kind')} must be one of: current, named, orbit-from-current, look-from.`;
    }
  }

  /** A multi capture's cell views: 2-6, each a valid view. */
  static validateMany(raw: unknown): ScreenshotView[] | string {
    if (!Array.isArray(raw) || raw.length < ScreenshotViews.MIN_MULTI || raw.length > ScreenshotViews.MAX_MULTI) {
      return `\`views\` must be an array of ${ScreenshotViews.MIN_MULTI}-${ScreenshotViews.MAX_MULTI} views.`;
    }
    const views: ScreenshotView[] = [];
    for (let i = 0; i < raw.length; i++) {
      const view = ScreenshotViews.validate(raw[i], `\`views[${i}]\``);
      if (typeof view === 'string') {
        return view;
      }
      views.push(view);
    }
    return views;
  }

  static isVec3(value: unknown): value is [number, number, number] {
    return (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((n) => typeof n === 'number' && Number.isFinite(n))
    );
  }
}
