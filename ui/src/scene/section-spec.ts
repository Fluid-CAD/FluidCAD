// The serializable description of a section (cut-away) view and the pure
// math behind it. No three.js here: the same shape crosses the wire from the
// MCP through the server (mirrored in server/src/ws-protocol.ts and
// mcp/src/tools/screenshot-section.ts), and the interactive UI will drive
// the same {@link SectionController} from a dialog later.

export type Vec3Tuple = [number, number, number];

/** The world datum planes, named as `plane()` and the filters name them. */
export type SectionPlaneName = 'xy' | 'yz' | 'xz';

export type SectionPlaneSpec = SectionPlaneName | { origin: Vec3Tuple; normal: Vec3Tuple };

/**
 * A section view, in document units.
 *
 * - `plane`: a named world datum plane or an explicit `{ origin, normal }`.
 * - `offset`: moves the cut plane along its normal (default 0).
 * - `flip`: keeps the other half.
 *
 * Convention: the normal points at the half that is removed. A section on
 * `xy` removes everything above z = offset and shows the cut from above, so
 * `{ plane: 'xy', offset: 10 }` viewed from `top` reads like a drawing's
 * section A-A taken at z = 10. `flip` keeps the +normal half instead. This is
 * the same sense the sketch-mode clipper uses (it removes the half on the
 * sketch plane's normal side, the side the sketcher looks from).
 */
export interface SectionSpec {
  plane: SectionPlaneSpec;
  offset?: number;
  flip?: boolean;
}

/** A section with the plane resolved to numbers and the sides worked out. */
export interface ResolvedSection {
  /** Unit normal of the cut plane, as specified (a named plane's +axis). */
  normal: Vec3Tuple;
  /** A point on the cut plane: the plane origin moved `offset` along `normal`. */
  point: Vec3Tuple;
  /** Unit direction from the cut plane into the removed half. */
  removedDirection: Vec3Tuple;
  /** Unit direction from the cut plane into the kept half (`-removedDirection`). */
  keptDirection: Vec3Tuple;
  /**
   * The material clipping plane that realizes the cut, in three.js's sense:
   * a fragment at `p` is discarded when `dot(normal, p) + constant < 0`.
   * Points on the kept side have a non-negative signed distance.
   */
  clipPlane: { normal: Vec3Tuple; constant: number };
}

/**
 * Validation and resolution of a {@link SectionSpec}. Static and free of
 * three.js so a server can check the same shape; the three `Plane` adapter
 * lives in section-controller.ts.
 */
export class SectionPlaneMath {

  static readonly PLANE_NAMES: readonly SectionPlaneName[] = ['xy', 'yz', 'xz'];

  /** The datum planes: origin at the world origin, normal along the third axis. */
  static readonly NAMED: Readonly<Record<SectionPlaneName, { origin: Vec3Tuple; normal: Vec3Tuple }>> = {
    xy: { origin: [0, 0, 0], normal: [0, 0, 1] },
    yz: { origin: [0, 0, 0], normal: [1, 0, 0] },
    xz: { origin: [0, 0, 0], normal: [0, 1, 0] },
  };

  /**
   * Check an untrusted value and return a clean copy of the spec, or an error
   * message naming the field under `label`.
   */
  static validate(raw: unknown, label = 'section'): SectionSpec | string {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return `${label} must be an object { plane, offset?, flip? }.`;
    }
    const s = raw as Record<string, unknown>;
    const plane = SectionPlaneMath.validatePlane(s.plane, `${label}.plane`);
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

  /** The plane part of a spec (a name is itself a valid string, so errors travel in an object). */
  static validatePlane(raw: unknown, label: string): { plane: SectionPlaneSpec } | { error: string } {
    const choices = `${label} must be one of ${SectionPlaneMath.PLANE_NAMES.join(', ')} or an object { origin, normal }.`;
    if (typeof raw === 'string') {
      if (!SectionPlaneMath.isPlaneName(raw)) {
        return { error: choices };
      }
      return { plane: raw };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: choices };
    }
    const p = raw as Record<string, unknown>;
    if (!SectionPlaneMath.isVec3(p.origin)) {
      return { error: `${label}.origin must be a 3-element array of finite numbers (document units).` };
    }
    if (!SectionPlaneMath.isVec3(p.normal)) {
      return { error: `${label}.normal must be a 3-element array of finite numbers.` };
    }
    if (SectionPlaneMath.length(p.normal) === 0) {
      return { error: `${label}.normal must not be the zero vector.` };
    }
    return { plane: { origin: [...p.origin], normal: [...p.normal] } };
  }

  static isPlaneName(value: unknown): value is SectionPlaneName {
    return typeof value === 'string' && (SectionPlaneMath.PLANE_NAMES as readonly string[]).includes(value);
  }

  /** Resolve a (validated) spec: unit normal, cut point, sides and clip plane. */
  static resolve(spec: SectionSpec): ResolvedSection {
    const source = typeof spec.plane === 'string' ? SectionPlaneMath.NAMED[spec.plane] : spec.plane;
    const normal = SectionPlaneMath.unit(source.normal);
    const offset = spec.offset ?? 0;
    const point: Vec3Tuple = [
      source.origin[0] + normal[0] * offset,
      source.origin[1] + normal[1] * offset,
      source.origin[2] + normal[2] * offset,
    ];
    const removedDirection: Vec3Tuple = spec.flip ? SectionPlaneMath.negate(normal) : normal;
    const keptDirection = SectionPlaneMath.negate(removedDirection);
    return {
      normal,
      point,
      removedDirection,
      keptDirection,
      clipPlane: { normal: keptDirection, constant: -SectionPlaneMath.dot(keptDirection, point) },
    };
  }

  /** Signed distance from the cut plane, positive on the kept side. */
  static signedDistance(section: ResolvedSection, p: Vec3Tuple): number {
    return SectionPlaneMath.dot(section.clipPlane.normal, p) + section.clipPlane.constant;
  }

  /** Whether `p` survives the cut (points on the plane count as kept). */
  static keeps(section: ResolvedSection, p: Vec3Tuple): boolean {
    return SectionPlaneMath.signedDistance(section, p) >= 0;
  }

  static isVec3(value: unknown): value is Vec3Tuple {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  }

  static dot(a: Vec3Tuple, b: Vec3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  static length(v: Vec3Tuple): number {
    return Math.sqrt(SectionPlaneMath.dot(v, v));
  }

  static unit(v: Vec3Tuple): Vec3Tuple {
    const len = SectionPlaneMath.length(v);
    if (len === 0) {
      return [0, 0, 0];
    }
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  static negate(v: Vec3Tuple): Vec3Tuple {
    return [-v[0], -v[1], -v[2]];
  }
}
