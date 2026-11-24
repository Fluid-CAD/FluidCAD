import type { SketchImportPlan, SketchJoinEnd, SketchPrimitive } from '../../../../lib/io/drawing/sketch-import.js';
import type { Vec2 } from '../../../../lib/io/drawing/drawing.js';
import type { SolvedEmissionRequest, SolvedEmissionTargetParam, SolvedGeometryParam } from './solved-emission';

/**
 * An import plan as the one edit that writes it: a statement per primitive
 * and a `coincident` per join, through the same rail the drawing tools use.
 *
 * Unlike a clicked position (two decimals), an imported coordinate is
 * written as the plan rounded it: a drawing's corners, tangencies and
 * centres are only as exact as their numbers.
 */
export class DrawingImportEmission {
  /** A number as source text: plain decimal notation, never an exponent. */
  static number(value: number): string {
    // The shortest text that reads back as the same number — what the plan
    // rounded to — unless that text is in exponent form (a value under 1e-6).
    const text = String(value);
    if (!/e/i.test(text)) {
      return text;
    }
    return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '').replace(/^-0$/, '0');
  }

  static point(p: Vec2): string {
    return `[${DrawingImportEmission.number(p.x)}, ${DrawingImportEmission.number(p.y)}]`;
  }

  /** The statement that draws a primitive, without a binding or a semicolon. */
  static statement(primitive: SketchPrimitive): SolvedGeometryParam {
    const n = DrawingImportEmission.number;
    const p = DrawingImportEmission.point;
    switch (primitive.kind) {
      case 'line':
        return { kind: 'line', text: `line(${p(primitive.start)}, ${p(primitive.end)})` };
      case 'arc':
        return { kind: 'arc', text: `arc(${p(primitive.start)}, ${p(primitive.end)}, ${p(primitive.center)})` };
      case 'circle':
        return { kind: 'circle', text: `circle(${p(primitive.center)}, ${n(primitive.diameter)})` };
      case 'ellipse': {
        const rotation = primitive.rotation !== 0 ? `, ${n(primitive.rotation)}` : '';
        return { kind: 'ellipse', text: `ellipse(${p(primitive.center)}, ${n(primitive.rx)}, ${n(primitive.ry)}${rotation})` };
      }
      case 'bezier':
        return { kind: 'bezier', text: `bezier(${primitive.points.map(p).join(', ')})` };
    }
  }

  /**
   * The whole plan as one emission. With `joins` off only the geometry is
   * written: the outline looks the same and comes apart when dragged.
   */
  static request(plan: SketchImportPlan, options: { joins: boolean }): SolvedEmissionRequest {
    const target = (end: SketchJoinEnd): SolvedEmissionTargetParam => {
      const primitive = plan.primitives[end.primitive];
      if (primitive.kind === 'bezier') {
        // A bezier is no solver entity: its ends are its first and last points.
        return {
          newIndex: end.primitive,
          featureType: 'bezier',
          pointIndex: end.end === 'start' ? 0 : primitive.points.length - 1,
        };
      }
      return { newIndex: end.primitive, role: end.end };
    };
    return {
      geometry: plan.primitives.map(DrawingImportEmission.statement),
      constraints: options.joins
        ? plan.joins.map((join) => ({ kind: 'coincident', targets: [target(join.a), target(join.b)] }))
        : [],
    };
  }
}
