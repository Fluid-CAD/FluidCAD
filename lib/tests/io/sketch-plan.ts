import { render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { arc, bezier, circle, ellipse, line } from "../../core/2d/index.js";
import { coincident, diameter, distance, fix, horizontal, radius, vertical } from "../../core/constraints/index.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import type { SketchImportPlan, SketchJoinEnd, SketchPin, SketchPinPoint } from "../../io/drawing/sketch-import.js";
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
  const made = plan.primitives.map((primitive) => {
    switch (primitive.kind) {
      case 'line':
        return line(p(primitive.start), p(primitive.end));
      case 'arc':
        return arc(p(primitive.start), p(primitive.end), p(primitive.center));
      case 'circle':
        return circle(p(primitive.center), primitive.diameter);
      case 'ellipse':
        return ellipse(p(primitive.center), primitive.rx, primitive.ry, primitive.rotation);
      case 'bezier':
        return bezier(...primitive.points.map(p));
    }
  });
  const end = (ref: SketchJoinEnd) => {
    const primitive = plan.primitives[ref.primitive];
    const statement = made[ref.primitive] as any;
    if (primitive.kind === 'bezier') {
      return statement.point(ref.end === 'start' ? 0 : primitive.points.length - 1);
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

/** How the solver left a sketch of the plan with its pins. */
export function solved(plan: SketchImportPlan, joined: boolean): { outcome: string; dof: number; redundant: number; conflicting: number } {
  const pins = SketchImport.pins(plan, { joined, decimals: OPTIONS.decimals });
  const sk = sketch("xy", () => draw(plan, pins, joined)) as any;
  const solver = render().getRenderedObjects().find((o) => o.id === sk.id)!.object.solver;
  return { outcome: solver.outcome, dof: solver.dof, redundant: solver.redundant.length, conflicting: solver.conflicting.length };
}

/** The volume of the plan's profile extruded by `height`, and how the solver left its sketch. */
export function extrudedVolume(plan: SketchImportPlan, height: number): { volume: number; outcome: string } {
  const sk = sketch("xy", () => draw(plan)) as any;
  extrude(height);
  const scene = render();
  const solid = scene.getAllSceneObjects().flatMap((o) => o.getShapes()).find((s) => s.getType() === "solid") as Solid;
  const row = scene.getRenderedObjects().find((o) => o.id === sk.id)!;
  return { volume: ShapeProps.getProperties(solid.getShape()).volumeMm3, outcome: row.object.solver.outcome };
}
