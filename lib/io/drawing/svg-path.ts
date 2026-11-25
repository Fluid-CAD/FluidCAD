import type { Vec2 } from "./drawing.js";
import type { PathSegment, Subpath } from "./path-segments.js";

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** How many numbers each command takes; an arc's fourth and fifth are its two flags. */
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * SVG path data (the `d` of a `<path>`) as the segments it draws, in the
 * path's own coordinates.
 *
 * The whole grammar: `M L H V C S Q T A Z` and their relative forms,
 * numbers run together the way writers pack them (`1.5.5`, `1-2`, `1e-3`),
 * arc flags without a space after them (`a1 1 0 00.5.5`), commands repeated
 * without their letter, and the line a move draws to each further pair.
 * Relative coordinates are resolved, so everything that comes out is
 * absolute; `S` and `T` get the control point they leave implied.
 *
 * Path data that goes wrong part-way is drawn up to the command with the
 * error, as the format has a renderer do, and `error` says it happened.
 */
export class SvgPathData {
  static parse(d: string): { subpaths: Subpath[]; error: boolean } {
    const subpaths: Subpath[] = [];
    let error = false;
    let i = 0;

    /** The current point, and where the current subpath started. */
    let pen: Vec2 = { x: 0, y: 0 };
    let start: Vec2 = { x: 0, y: 0 };
    /** The subpath being drawn; opened by the first segment after a move or a close. */
    let current: Subpath | null = null;
    /** The last control point of the previous command when it was a cubic, or a quadratic: what `S` and `T` mirror. */
    let cubicControl: Vec2 | null = null;
    let quadraticControl: Vec2 | null = null;

    const skipSpace = () => {
      while (i < d.length) {
        const c = d.charCodeAt(i);
        if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) {
          break;
        }
        i++;
      }
    };
    const skipSeparator = () => {
      skipSpace();
      if (d[i] === ',') {
        i++;
        skipSpace();
      }
    };
    const number = (): number | null => {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(d);
      if (!match) {
        return null;
      }
      const value = Number(match[0]);
      if (!Number.isFinite(value)) {
        return null;
      }
      i = NUMBER.lastIndex;
      return value;
    };
    const add = (segment: PathSegment | null) => {
      if (!segment) {
        return;
      }
      if (!current) {
        current = { segments: [], closed: false };
        subpaths.push(current);
      }
      current.segments.push(segment);
    };
    const same = (p: Vec2, q: Vec2) => p.x === q.x && p.y === q.y;
    const lineTo = (to: Vec2) => {
      if (!same(pen, to)) {
        add({ kind: 'line', a: pen, b: to });
      }
      pen = to;
    };

    skipSpace();
    let first = true;
    while (i < d.length) {
      const letter = d[i];
      const command = letter.toLowerCase();
      const arity = ARITY[command];
      if (arity === undefined || (first && command !== 'm')) {
        error = true;
        break;
      }
      i++;
      const relative = letter === command;

      if (command === 'z') {
        if (current) {
          // Back to where the subpath started, by a line when it is not there yet.
          lineTo(start);
          (current as Subpath).closed = true;
          current = null;
        }
        pen = start;
        cubicControl = null;
        quadraticControl = null;
        skipSpace();
        first = false;
        continue;
      }

      // The command's numbers, then again for as long as more follow without a letter.
      let groups = 0;
      for (;;) {
        if (groups === 0) {
          skipSpace();
        } else {
          const before = i;
          skipSeparator();
          const c = d[i];
          if (c === undefined || !(c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9'))) {
            // Not another group: a letter, or the end. A comma left hanging is let through.
            if (d[i] !== undefined && !/[a-zA-Z]/.test(d[i])) {
              error = true;
            }
            if (error) {
              i = before;
            }
            break;
          }
        }
        const values: number[] = [];
        for (let k = 0; k < arity; k++) {
          if (k > 0) {
            skipSeparator();
          }
          if (command === 'a' && (k === 3 || k === 4)) {
            // A flag is one character, with or without anything after it.
            const flag = d[i];
            if (flag !== '0' && flag !== '1') {
              break;
            }
            i++;
            values.push(flag === '1' ? 1 : 0);
            continue;
          }
          const value = number();
          if (value === null) {
            break;
          }
          values.push(value);
        }
        if (values.length !== arity) {
          error = true;
          break;
        }
        groups++;
        const x = (value: number) => (relative ? pen.x + value : value);
        const y = (value: number) => (relative ? pen.y + value : value);
        // A move's further pairs are lines.
        const drawn = command === 'm' && groups > 1 ? 'l' : command;
        let nextCubic: Vec2 | null = null;
        let nextQuadratic: Vec2 | null = null;
        switch (drawn) {
          case 'm':
            // A relative move that opens the path counts from the origin, which is where the pen starts.
            pen = { x: x(values[0]), y: y(values[1]) };
            start = pen;
            current = null;
            break;
          case 'l':
            lineTo({ x: x(values[0]), y: y(values[1]) });
            break;
          case 'h':
            lineTo({ x: x(values[0]), y: pen.y });
            break;
          case 'v':
            lineTo({ x: pen.x, y: y(values[0]) });
            break;
          case 'c':
          case 's': {
            const offset = drawn === 'c' ? 2 : 0;
            const control1: Vec2 = drawn === 'c'
              ? { x: x(values[0]), y: y(values[1]) }
              // The previous cubic's last control point, mirrored in the pen — or the pen itself after anything else.
              : cubicControl ? { x: 2 * pen.x - cubicControl.x, y: 2 * pen.y - cubicControl.y } : pen;
            const control2 = { x: x(values[offset]), y: y(values[offset + 1]) };
            const to = { x: x(values[offset + 2]), y: y(values[offset + 3]) };
            if (!(same(pen, control1) && same(pen, control2) && same(pen, to))) {
              add({ kind: 'bezier', points: [pen, control1, control2, to] });
            }
            nextCubic = control2;
            pen = to;
            break;
          }
          case 'q':
          case 't': {
            const offset = drawn === 'q' ? 2 : 0;
            const control: Vec2 = drawn === 'q'
              ? { x: x(values[0]), y: y(values[1]) }
              : quadraticControl ? { x: 2 * pen.x - quadraticControl.x, y: 2 * pen.y - quadraticControl.y } : pen;
            const to = { x: x(values[offset]), y: y(values[offset + 1]) };
            if (!(same(pen, control) && same(pen, to))) {
              add({ kind: 'bezier', points: [pen, control, to] });
            }
            nextQuadratic = control;
            pen = to;
            break;
          }
          case 'a': {
            const to = { x: x(values[5]), y: y(values[6]) };
            add(SvgPathData.arc(pen, values[0], values[1], values[2], values[3] === 1, values[4] === 1, to));
            pen = to;
            break;
          }
        }
        cubicControl = nextCubic;
        quadraticControl = nextQuadratic;
      }
      if (error) {
        break;
      }
      first = false;
    }
    return { subpaths: subpaths.filter((subpath) => subpath.segments.length > 0), error };
  }

  /**
   * An arc command as a segment: the arc of the ellipse with radii `rx` and
   * `ry`, its x axis turned by `rotation` degrees, from `from` to `to` —
   * the one of the four such arcs the two flags pick. The format states an
   * arc by its ends; this works out its centre the way the specification
   * lays down (its implementation notes, "conversion from endpoint to
   * center parameterization").
   *
   * A radius of zero makes it the straight line between the ends; radii too
   * small to span the ends are grown until they just do. Null when the two
   * ends are one point: the format has such an arc draw nothing.
   */
  static arc(from: Vec2, rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, to: Vec2): PathSegment | null {
    if (from.x === to.x && from.y === to.y) {
      return null;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (!(rx > 0) || !(ry > 0)) {
      return { kind: 'line', a: from, b: to };
    }
    const phi = (rotation * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    // The ends seen from their midpoint, in the ellipse's own frame.
    const dx = (from.x - to.x) / 2;
    const dy = (from.y - to.y) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
      rx *= Math.sqrt(lambda);
      ry *= Math.sqrt(lambda);
    }
    const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
    const cxp = (factor * rx * y1) / ry;
    const cyp = (-factor * ry * x1) / rx;
    const center = {
      x: cos * cxp - sin * cyp + (from.x + to.x) / 2,
      y: sin * cxp + cos * cyp + (from.y + to.y) / 2,
    };
    const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const sx = (x1 - cxp) / rx;
    const sy = (y1 - cyp) / ry;
    const theta = angle(1, 0, sx, sy);
    let delta = angle(sx, sy, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    // The flag says which way round: towards growing angles, or shrinking ones.
    if (!sweep && delta > 0) {
      delta -= 2 * Math.PI;
    } else if (sweep && delta < 0) {
      delta += 2 * Math.PI;
    }
    if (delta === 0) {
      return null;
    }
    const u = { x: rx * cos, y: rx * sin };
    const v = { x: -ry * sin, y: ry * cos };
    // A segment's parameter only grows: a run towards shrinking angles is the mirrored ellipse run forwards.
    return delta > 0
      ? { kind: 'conic', center, u, v, t0: theta, t1: theta + delta }
      : { kind: 'conic', center, u, v: { x: -v.x, y: -v.y }, t0: -theta, t1: -theta - delta };
  }
}
