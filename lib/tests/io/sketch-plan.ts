import { render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { arc, bezier, circle, eArc, ellipse, line, point as sketchPoint, text } from "../../core/2d/index.js";
import { coincident, diameter, distance, fix, horizontal, radius, vertical } from "../../core/constraints/index.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import type { SketchImportPlan, SketchJoinEnd, SketchPin, SketchPinPoint, SketchPrimitive } from "../../io/drawing/sketch-import.js";
import { ShapeProps } from "../../oc/props.js";
import type { Solid } from "../../common/solid.js";

// An import plan drawn into a real sketch, the way the import tool writes
// it — here as the calls themselves instead of source text. What the tests
// of each file format share: a plan's geometry has to mean the same thing to
// the sketch as it did to the file.

export const OPTIONS = { tolerance: 1e-5, joinTolerance: 1e-3, decimals: 6 };

/** The statements of a plan, as the tool writes them: the geometry, its joins when `joined`, and `pins`. */
export function draw(plan: SketchImportPlan, pins: SketchPin[] = [], joined = true): void {
  const p = (v: { x: number; y: number }): [number, number] => [v.x, v.y];
  /** One primitive as its statement; `before` are the statements of the primitives ahead of it. */
  const write = (primitive: SketchPrimitive, before: readonly any[]): any => {
    switch (primitive.kind) {
      case 'line': {
        const drawn = line(p(primitive.start), p(primitive.end));
        return primitive.guide ? drawn.guide() : drawn;
      }
      case 'arc':
        return arc(p(primitive.start), p(primitive.end), p(primitive.center));
      case 'circle':
        return circle(p(primitive.center), primitive.diameter);
      case 'ellipse':
        return ellipse(p(primitive.center), primitive.rx, primitive.ry, primitive.rotation);
      case 'eArc':
        return eArc(p(primitive.start), p(primitive.end), p(primitive.center), primitive.rx, primitive.ry, primitive.rotation);
      case 'bezier':
        return bezier(...primitive.points.map(p));
      case 'point':
        return sketchPoint(p(primitive.at));
      case 'text': {
        // The statement the tool writes: only what differs from a text's defaults, the anchor last.
        let drawn = primitive.path !== undefined ? text(primitive.text, before[primitive.path]) : text(primitive.text);
        drawn = drawn.font(primitive.font).size(primitive.size);
        if (primitive.bold) {
          drawn = drawn.bold();
        }
        if (primitive.italic) {
          drawn = drawn.italic();
        }
        if (primitive.align !== 'left') {
          drawn = drawn.align(primitive.align);
        }
        if (primitive.lineSpacing !== 1) {
          drawn = drawn.lineSpacing(primitive.lineSpacing);
        }
        if (primitive.letterSpacing !== 0) {
          drawn = drawn.letterSpacing(primitive.letterSpacing);
        }
        return primitive.at ? drawn.at(p(primitive.at)) : drawn;
      }
    }
  };
  const made: any[] = [];
  for (const primitive of plan.primitives) {
    made.push(write(primitive, made));
  }
  const end = (ref: SketchJoinEnd) => {
    const primitive = plan.primitives[ref.primitive];
    const statement = made[ref.primitive] as any;
    if (primitive.kind === 'bezier') {
      return statement.point(ref.end === 'start' ? 0 : primitive.points.length - 1);
    }
    if (ref.end === 'point') {
      return statement;
    }
    return ref.end === 'start' ? statement.start() : statement.end();
  };
  for (const join of joined ? plan.joins : []) {
    coincident(end(join.a), end(join.b));
  }
  const point = (ref: SketchPinPoint) => {
    const statement = made[ref.primitive] as any;
    if (typeof ref.point === 'number') {
      return statement.point(ref.point);
    }
    if (ref.point === 'anchor') {
      return statement.anchor();
    }
    return ref.point === 'center' ? statement.center() : end({ primitive: ref.primitive, end: ref.point });
  };
  for (const pin of pins) {
    const statement = made[(pin as { primitive: number }).primitive] as any;
    switch (pin.kind) {
      case 'fix':
        fix(point(pin.point));
        break;
      case 'radius':
        radius(statement, pin.value);
        break;
      case 'offset':
        distance(statement.start(), statement.center(), pin.value, pin.axis);
        break;
      case 'aligned':
        (pin.direction === 'horizontal' ? horizontal : vertical)(statement.start(), statement.center());
        break;
      case 'diameter':
        diameter(statement, pin.value);
        break;
      case 'semi-radius':
        radius(statement, pin.value, pin.axis);
        break;
      case 'level':
        (pin.direction === 'horizontal' ? horizontal : vertical)(statement);
        break;
    }
  }
}

/** How the solver left a sketch of the plan with its pins. The sketch is the only thing in its scene, so one test can ask about many plans. */
export function solved(plan: SketchImportPlan, joined: boolean): { outcome: string; dof: number; redundant: number; conflicting: number } {
  getSceneManager().startScene();
  const pins = SketchImport.pins(plan, { joined, decimals: OPTIONS.decimals });
  const sk = sketch("xy", () => draw(plan, pins, joined)) as any;
  const solver = render().getRenderedObjects().find((o) => o.id === sk.id)!.object.solver;
  return { outcome: solver.outcome, dof: solver.dof, redundant: solver.redundant.length, conflicting: solver.conflicting.length };
}

/** A solved line or elliptical arc as its statement serializes it. */
export type DrawnCurve = { type: string; start: { x: number; y: number }; end: { x: number; y: number }; rx?: number; ry?: number; rotation?: number; center?: { x: number; y: number } };

/**
 * The lines and elliptical arcs the kernel drew for the plan, in the
 * plan's order, with `pins` and, when `joined`, its joins; and how the
 * solver left the sketch. The sketch is the only thing in its scene.
 */
export function drawnCurves(plan: SketchImportPlan, pins: SketchPin[], joined: boolean): { curves: DrawnCurve[]; outcome: string; dof: number; redundant: number; conflicting: number } {
  getSceneManager().startScene();
  const sk = sketch("xy", () => draw(plan, pins, joined)) as any;
  const scene = render();
  const curves = scene.getAllSceneObjects()
    .filter((o) => o.getType() === 'line' || o.getType() === 'eArc')
    .map((o) => ({ type: o.getType(), ...(o.serialize() as Omit<DrawnCurve, 'type'>) }));
  const solver = scene.getRenderedObjects().find((o) => o.id === sk.id)!.object.solver;
  return { curves, outcome: solver.outcome, dof: solver.dof, redundant: solver.redundant.length, conflicting: solver.conflicting.length };
}

/**
 * The volume of the plan's profile extruded by `height`, and how the solver
 * left its sketch; `joined` writes the plan's joins. The sketch and its
 * extrusion are the only things in their scene.
 */
export function extrudedVolume(plan: SketchImportPlan, height: number, joined = true): { volume: number; outcome: string } {
  getSceneManager().startScene();
  const sk = sketch("xy", () => draw(plan, [], joined)) as any;
  extrude(height);
  const scene = render();
  const solid = scene.getAllSceneObjects().flatMap((o) => o.getShapes()).find((s) => s.getType() === "solid") as Solid;
  const row = scene.getRenderedObjects().find((o) => o.id === sk.id)!;
  return { volume: ShapeProps.getProperties(solid.getShape()).volumeMm3, outcome: row.object.solver.outcome };
}
