import type { Vec2 } from "./drawing.js";
import type { SketchJoinEnd, SketchPrimitive } from "./sketch-import.js";

/** An end a join can name, and where it is written. */
export type SketchEnd = SketchJoinEnd & { at: Vec2 };

/**
 * The ends of a plan's primitives: what joins are found between, and what
 * moves when two ends are to be written at one point.
 */
export class SketchEnds {
  /**
   * Every end of `primitives` a join can name, in order: the two ends of a
   * line, an arc or an elliptical arc, a bezier's first and last point, and
   * a point primitive itself. A guide line has none: its ends are where an
   * endless line was cut. A circle, an ellipse and a text have none either.
   */
  static of(primitives: readonly SketchPrimitive[]): SketchEnd[] {
    const ends: SketchEnd[] = [];
    primitives.forEach((primitive, index) => {
      switch (primitive.kind) {
        case 'line':
          if (primitive.guide) {
            break;
          }
          ends.push({ primitive: index, end: 'start', at: primitive.start }, { primitive: index, end: 'end', at: primitive.end });
          break;
        case 'arc':
        case 'eArc':
          ends.push({ primitive: index, end: 'start', at: primitive.start }, { primitive: index, end: 'end', at: primitive.end });
          break;
        case 'bezier':
          ends.push(
            { primitive: index, end: 'start', at: primitive.points[0] },
            { primitive: index, end: 'end', at: primitive.points[primitive.points.length - 1] },
          );
          break;
        case 'point':
          ends.push({ primitive: index, end: 'point', at: primitive.at });
          break;
      }
    });
    return ends;
  }

  /** The primitive with its end `end` written at `to`, everything else as it was. */
  static moved(primitive: SketchPrimitive, end: SketchJoinEnd['end'], to: Vec2): SketchPrimitive {
    switch (primitive.kind) {
      case 'line':
      case 'arc':
      case 'eArc':
        return end === 'start' ? { ...primitive, start: to } : end === 'end' ? { ...primitive, end: to } : primitive;
      case 'bezier': {
        const points = [...primitive.points];
        points[end === 'start' ? 0 : points.length - 1] = to;
        return { ...primitive, points };
      }
      case 'point':
        return { ...primitive, at: to };
      default:
        return primitive;
    }
  }
}
