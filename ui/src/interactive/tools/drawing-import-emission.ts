import { SketchImport } from '../../../../lib/io/drawing/sketch-import.js';
import type { SketchImportPlan, SketchJoinEnd, SketchPin, SketchPinPoint, SketchPrimitive } from '../../../../lib/io/drawing/sketch-import.js';
import type { Vec2 } from '../../../../lib/io/drawing/drawing.js';
import type { SolvedConstraintParam, SolvedEmissionRequest, SolvedEmissionTargetParam, SolvedGeometryParam } from './solved-emission';

/**
 * An import plan as the one edit that writes it: a statement per primitive
 * (a `point` for a point of the file, a guide line for a construction line)
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
        return {
          kind: 'line',
          text: `line(${p(primitive.start)}, ${p(primitive.end)})`,
          // A construction line: the server writes `.guide()` after it.
          ...(primitive.guide ? { guide: true } : {}),
        };
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
      case 'point':
        return { kind: 'point', text: `point(${p(primitive.at)})` };
    }
  }

  /**
   * The whole plan as one emission. With `joins` off only the geometry is
   * written: the outline looks the same and comes apart when dragged. With
   * `fix` the geometry is also pinned where it is — every point fixed once,
   * every size dimensioned (see `SketchImport.pins`) — so nothing of it can
   * be dragged until the constraint holding it is deleted. `decimals` are
   * the plan's.
   */
  static request(plan: SketchImportPlan, options: { joins: boolean; fix: boolean; decimals: number }): SolvedEmissionRequest {
    const end = (ref: SketchJoinEnd): SolvedEmissionTargetParam => {
      const primitive = plan.primitives[ref.primitive];
      if (primitive.kind === 'bezier') {
        // A bezier is no solver entity: its ends are its first and last points.
        return {
          newIndex: ref.primitive,
          featureType: 'bezier',
          pointIndex: ref.end === 'start' ? 0 : primitive.points.length - 1,
        };
      }
      // A point statement is the point: no role to name on it.
      return ref.end === 'point' ? { newIndex: ref.primitive } : { newIndex: ref.primitive, role: ref.end };
    };
    const point = (ref: SketchPinPoint): SolvedEmissionTargetParam => {
      if (typeof ref.point === 'number') {
        return { newIndex: ref.primitive, featureType: 'bezier', pointIndex: ref.point };
      }
      return ref.point === 'center'
        ? { newIndex: ref.primitive, role: 'center' }
        : end({ primitive: ref.primitive, end: ref.point });
    };
    const n = DrawingImportEmission.number;
    const pin = (p: SketchPin): SolvedConstraintParam => {
      switch (p.kind) {
        case 'fix':
          return { kind: 'fix', targets: [point(p.point)] };
        case 'radius':
          return { kind: 'radius', targets: [{ newIndex: p.primitive }], valueExpr: n(p.value) };
        case 'offset':
          return {
            kind: 'distance',
            targets: [{ newIndex: p.primitive, role: 'start' }, { newIndex: p.primitive, role: 'center' }],
            valueExpr: n(p.value),
            axis: p.axis,
          };
        case 'aligned':
          return {
            kind: p.direction,
            targets: [{ newIndex: p.primitive, role: 'start' }, { newIndex: p.primitive, role: 'center' }],
          };
        case 'diameter':
          return { kind: 'diameter', targets: [{ newIndex: p.primitive }], valueExpr: n(p.value) };
        case 'semi-radius':
          return { kind: 'radius', targets: [{ newIndex: p.primitive }], valueExpr: n(p.value), axis: p.axis };
        case 'level':
          return { kind: p.direction, targets: [{ newIndex: p.primitive }] };
      }
    };
    const joins: SolvedConstraintParam[] = options.joins
      ? plan.joins.map((join) => ({ kind: 'coincident', targets: [end(join.a), end(join.b)] }))
      : [];
    const pins = options.fix
      ? SketchImport.pins(plan, { joined: options.joins, decimals: options.decimals }).map(pin)
      : [];
    return {
      geometry: plan.primitives.map(DrawingImportEmission.statement),
      constraints: [...joins, ...pins],
    };
  }
}
