import { Affine, type Affine2 } from "./affine.js";

/** A length as written: a number with the unit after it (lower-cased; empty for a bare number, `%` for a percentage). */
export type SvgLength = { value: number; unit: string };

export type SvgViewBox = { x: number; y: number; width: number; height: number };

/** `preserveAspectRatio`: where a view box sits in its viewport when their proportions differ. */
export type SvgAspect = {
  /** False for `none`: the box is stretched to fill the viewport, each axis by its own factor. */
  uniform: boolean;
  /** Where the box sits along each axis: 0 at the start (`Min`), 0.5 centred (`Mid`), 1 at the end (`Max`). */
  alignX: number;
  alignY: number;
  /** `slice`: scaled to cover the viewport instead of to fit in it. */
  slice: boolean;
};

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_ONLY = new RegExp(String.raw`^\s*(${NUMBER})\s*$`);
const LENGTH = new RegExp(String.raw`^\s*(${NUMBER})\s*([a-zA-Z]+|%)?\s*$`);
const NUMBER_IN_LIST = new RegExp(String.raw`[\s,]*(${NUMBER})`, 'y');
const TRANSFORM_FUNCTION = /\s*([a-zA-Z][a-zA-Z0-9]*)\s*\(([^()]*)\)\s*,?/y;

const DEG = Math.PI / 180;

/** An angle unit in degrees. */
const ANGLE_UNITS: Record<string, number> = { '': 1, deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/**
 * The values SVG attributes and properties are written in — numbers,
 * lengths, lists, view boxes and transform lists — read leniently: where
 * the format has an old attribute syntax and a newer CSS one (a transform
 * with or without units and commas), both are taken.
 */
export class SvgValues {
  /** User units per absolute unit at `perInch` user units to the inch: CSS has 96. Font-relative units take a 16-unit font. */
  static unitFactors(perInch: number): Record<string, number> {
    return {
      '': 1,
      px: 1,
      in: perInch,
      cm: perInch / 2.54,
      mm: perInch / 25.4,
      q: perInch / 101.6,
      pt: perInch / 72,
      pc: perInch / 6,
      em: 16,
      rem: 16,
      ex: 8,
      ch: 8,
    };
  }

  /** A bare number; null when the text is anything else. */
  static number(text: string | undefined): number | null {
    const match = text === undefined ? null : NUMBER_ONLY.exec(text);
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  /** A number with an optional unit or `%`; null when the text is not a length. */
  static length(text: string | undefined): SvgLength | null {
    const match = text === undefined ? null : LENGTH.exec(text);
    if (!match) {
      return null;
    }
    const value = Number(match[1]);
    return Number.isFinite(value) ? { value, unit: (match[2] ?? '').toLowerCase() } : null;
  }

  /**
   * The numbers of a list separated by white space or commas (`points`, a
   * view box), up to the first thing that is not a number — a list with an
   * error is drawn up to it.
   */
  static numbers(text: string | undefined): number[] {
    const numbers: number[] = [];
    if (text === undefined) {
      return numbers;
    }
    NUMBER_IN_LIST.lastIndex = 0;
    for (let match = NUMBER_IN_LIST.exec(text); match; match = NUMBER_IN_LIST.exec(text)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) {
        break;
      }
      numbers.push(value);
    }
    return numbers;
  }

  /** A `viewBox`; null when it is not four numbers or has no area (a box without one is no box). */
  static viewBox(text: string | undefined): SvgViewBox | null {
    if (text === undefined) {
      return null;
    }
    const parts = text.trim().split(/[\s,]+/).map((part) => SvgValues.number(part));
    if (parts.length !== 4 || parts.some((part) => part === null)) {
      return null;
    }
    const [x, y, width, height] = parts as number[];
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  }

  /** A `preserveAspectRatio`; anything unreadable is the default, `xMidYMid meet`. */
  static aspect(text: string | undefined): SvgAspect {
    const aspect: SvgAspect = { uniform: true, alignX: 0.5, alignY: 0.5, slice: false };
    const parts = (text ?? '').trim().split(/\s+/).filter((part) => part !== 'defer' && part.length > 0);
    if (parts.length === 0) {
      return aspect;
    }
    if (parts[0] === 'none') {
      aspect.uniform = false;
      return aspect;
    }
    const match = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(parts[0]);
    if (!match) {
      return aspect;
    }
    const share = { Min: 0, Mid: 0.5, Max: 1 } as const;
    aspect.alignX = share[match[1] as keyof typeof share];
    aspect.alignY = share[match[2] as keyof typeof share];
    aspect.slice = parts[1] === 'slice';
    return aspect;
  }

  /**
   * The map from a view box's coordinates to its viewport's — a viewport
   * `width` by `height` with its corner at the origin. The box is scaled to
   * fit inside the viewport (or to cover it, for `slice`) and aligned in
   * the room that leaves; with `none` each axis is scaled on its own.
   */
  static viewportTransform(box: SvgViewBox, aspect: SvgAspect, width: number, height: number): Affine2 {
    let scaleX = width / box.width;
    let scaleY = height / box.height;
    if (aspect.uniform) {
      const scale = aspect.slice ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
      scaleX = scale;
      scaleY = scale;
    }
    return {
      a: scaleX,
      b: 0,
      c: 0,
      d: scaleY,
      e: -box.x * scaleX + (aspect.uniform ? (width - box.width * scaleX) * aspect.alignX : 0),
      f: -box.y * scaleY + (aspect.uniform ? (height - box.height * scaleY) * aspect.alignY : 0),
    };
  }

  /**
   * A transform list as one map: `matrix`, `translate`, `scale`, `rotate`
   * (about the origin, or a point given after the angle), `skewX`, `skewY`,
   * and the CSS spellings (`translateX`, `scaleY`, `skew`, `rotateZ`, the
   * 3D forms that stay in the plane). The functions apply right to left:
   * the last one written acts on the geometry first.
   *
   * Null when the text is not a transform list this reads — a syntax error,
   * a percentage, a function that leaves the plane (`rotateX`,
   * `perspective`, a `matrix3d` that is not flat).
   */
  static transform(text: string, units: Readonly<Record<string, number>> = SvgValues.unitFactors(96)): Affine2 | null {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === 'none') {
      return Affine.IDENTITY;
    }
    let result = Affine.IDENTITY;
    TRANSFORM_FUNCTION.lastIndex = 0;
    let end = 0;
    for (let match = TRANSFORM_FUNCTION.exec(trimmed); match; match = TRANSFORM_FUNCTION.exec(trimmed)) {
      end = TRANSFORM_FUNCTION.lastIndex;
      const parts = match[2].trim().split(/[\s,]+/).filter((part) => part.length > 0);
      const one = SvgValues.transformFunction(match[1], parts, units);
      if (!one) {
        return null;
      }
      // What is written later acts first.
      result = Affine.compose(one, result);
    }
    return trimmed.slice(end).trim() === '' && end > 0 ? result : null;
  }

  private static transformFunction(name: string, parts: string[], units: Readonly<Record<string, number>>): Affine2 | null {
    const lengths = (): number[] | null => {
      const values: number[] = [];
      for (const part of parts) {
        const length = SvgValues.length(part);
        const factor = length ? units[length.unit] : undefined;
        if (!length || factor === undefined) {
          return null;
        }
        values.push(length.value * factor);
      }
      return values;
    };
    const numbers = (): number[] | null => {
      const values = parts.map((part) => SvgValues.number(part));
      return values.some((value) => value === null) ? null : values as number[];
    };
    /** An angle in radians. */
    const angle = (part: string | undefined): number | null => {
      const length = SvgValues.length(part);
      const factor = length ? ANGLE_UNITS[length.unit] : undefined;
      return length && factor !== undefined ? length.value * factor * DEG : null;
    };
    const rotation = (radians: number): Affine2 => {
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
    };
    const count = parts.length;

    switch (name.toLowerCase()) {
      case 'matrix': {
        const v = numbers();
        return v && count === 6 ? { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] } : null;
      }
      case 'matrix3d': {
        // Column-major 4×4; flat when nothing moves along, or depends on, Z.
        const v = numbers();
        if (!v || count !== 16 || v[2] !== 0 || v[3] !== 0 || v[6] !== 0 || v[7] !== 0 || v[8] !== 0 || v[9] !== 0 || v[11] !== 0 || v[15] !== 1) {
          return null;
        }
        return { a: v[0], b: v[1], c: v[4], d: v[5], e: v[12], f: v[13] };
      }
      case 'translate': {
        const v = lengths();
        return v && (count === 1 || count === 2) ? Affine.translation({ x: v[0], y: v[1] ?? 0 }) : null;
      }
      case 'translate3d': {
        const v = lengths();
        return v && count === 3 ? Affine.translation({ x: v[0], y: v[1] }) : null;
      }
      case 'translatex': {
        const v = lengths();
        return v && count === 1 ? Affine.translation({ x: v[0], y: 0 }) : null;
      }
      case 'translatey': {
        const v = lengths();
        return v && count === 1 ? Affine.translation({ x: 0, y: v[0] }) : null;
      }
      case 'translatez':
        return lengths() && count === 1 ? Affine.IDENTITY : null;
      case 'scale': {
        const v = numbers();
        return v && (count === 1 || count === 2) ? { a: v[0], b: 0, c: 0, d: v[1] ?? v[0], e: 0, f: 0 } : null;
      }
      case 'scale3d': {
        const v = numbers();
        return v && count === 3 ? { a: v[0], b: 0, c: 0, d: v[1], e: 0, f: 0 } : null;
      }
      case 'scalex': {
        const v = numbers();
        return v && count === 1 ? { a: v[0], b: 0, c: 0, d: 1, e: 0, f: 0 } : null;
      }
      case 'scaley': {
        const v = numbers();
        return v && count === 1 ? { a: 1, b: 0, c: 0, d: v[0], e: 0, f: 0 } : null;
      }
      case 'scalez':
        return numbers() && count === 1 ? Affine.IDENTITY : null;
      case 'rotate':
      case 'rotatez': {
        const radians = angle(parts[0]);
        if (radians === null || (count !== 1 && count !== 3)) {
          return null;
        }
        if (count === 1) {
          return rotation(radians);
        }
        // About a point: there, turned, and back.
        const cx = SvgValues.number(parts[1]);
        const cy = SvgValues.number(parts[2]);
        if (cx === null || cy === null) {
          return null;
        }
        return Affine.compose(
          Affine.translation({ x: -cx, y: -cy }),
          Affine.compose(rotation(radians), Affine.translation({ x: cx, y: cy })),
        );
      }
      case 'skewx': {
        const radians = angle(parts[0]);
        return radians !== null && count === 1 ? { a: 1, b: 0, c: Math.tan(radians), d: 1, e: 0, f: 0 } : null;
      }
      case 'skewy': {
        const radians = angle(parts[0]);
        return radians !== null && count === 1 ? { a: 1, b: Math.tan(radians), c: 0, d: 1, e: 0, f: 0 } : null;
      }
      case 'skew': {
        const x = angle(parts[0]);
        const y = count === 2 ? angle(parts[1]) : 0;
        return x !== null && y !== null && (count === 1 || count === 2)
          ? { a: 1, b: Math.tan(y), c: Math.tan(x), d: 1, e: 0, f: 0 }
          : null;
      }
      default:
        return null;
    }
  }
}
