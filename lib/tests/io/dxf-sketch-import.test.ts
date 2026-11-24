import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { arc, bezier, circle, ellipse, line } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import { DxfReader } from "../../io/drawing/dxf-reader.js";
import { DxfWriter } from "../../io/drawing/dxf-writer.js";
import { Affine } from "../../io/drawing/affine.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import type { SketchImportPlan, SketchJoinEnd } from "../../io/drawing/sketch-import.js";
import { Curves } from "../../io/drawing/drawing.js";
import type { Curve2D, DrawingEntity } from "../../io/drawing/drawing.js";
import { ShapeProps } from "../../oc/props.js";
import type { Solid } from "../../common/solid.js";

// The import end to end, the way the sketch DXF tool runs it: a file read,
// its curves planned as sketch statements, and those statements written —
// here as the calls themselves instead of source text — then extruded. What
// this pins is that the plan's geometry means the same thing to the sketch
// as it did to the file: an arc turns the way it turned, ends meet.

const OPTIONS = { tolerance: 1e-5, joinTolerance: 1e-3, decimals: 6 };

/** The statements of a plan, as the tool writes them. */
function draw(plan: SketchImportPlan): void {
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
  for (const join of plan.joins) {
    coincident(end(join.a), end(join.b));
  }
}

function extrudedVolume(plan: SketchImportPlan, height: number): { volume: number; outcome: string } {
  const sk = sketch("xy", () => draw(plan)) as any;
  extrude(height);
  const scene = render();
  const solid = scene.getAllSceneObjects().flatMap((o) => o.getShapes()).find((s) => s.getType() === "solid") as Solid;
  const row = scene.getRenderedObjects().find((o) => o.id === sk.id)!;
  return { volume: ShapeProps.getProperties(solid.getShape()).volumeMm3, outcome: row.object.solver.outcome };
}

function fileOf(curves: Curve2D[]): string {
  const entities: DrawingEntity[] = curves.map((curve) => ({ layer: 'visible', curve }));
  return DxfWriter.write({ unit: 'mm', entities, bounds: Curves.boundsOf(entities), warnings: [] });
}

describe("a DXF imported into a sketch", () => {
  setupOC();

  it("extrudes a polyline slot with a hole: bulge arcs turn the way the file drew them", () => {
    const text = [
      0, "SECTION", 2, "ENTITIES",
      0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1, 10, 0, 20, 0, 10, 20, 20, 0, 42, 1, 10, 20, 20, 10, 10, 0, 20, 10, 42, 1,
      0, "CIRCLE", 8, "0", 10, 10, 20, 5, 40, 2,
      0, "ENDSEC", 0, "EOF",
    ].join("\n");
    const plan = SketchImport.plan(DxfReader.read(text).entities.map((e) => e.curve), OPTIONS);
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'arc', 'line', 'arc', 'circle']);
    expect(plan.joins).toHaveLength(4);
    const { volume, outcome } = extrudedVolume(plan, 2);
    expect(outcome).toBe('solved');
    expect(volume).toBeCloseTo((20 * 10 + Math.PI * 25 - Math.PI * 4) * 2, 3);
  });

  it("extrudes the same area from a drawing on a flipped plane", () => {
    // The slot again, drawn on a plane seen from below (extrusion −Z): mirrored, the same size.
    const text = [
      0, "SECTION", 2, "ENTITIES",
      0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1, 10, 0, 20, 0, 10, 20, 20, 0, 42, 1, 10, 20, 20, 10, 10, 0, 20, 10, 42, 1,
      210, 0, 220, 0, 230, -1,
      0, "ENDSEC", 0, "EOF",
    ].join("\n");
    const curves = DxfReader.read(text).entities.map((e) => e.curve);
    expect(Curves.bounds(curves[1]).min.x).toBeCloseTo(-25, 9);
    const { volume } = extrudedVolume(SketchImport.plan(curves, OPTIONS), 1);
    expect(volume).toBeCloseTo(20 * 10 + Math.PI * 25, 3);
  });

  it("extrudes a profile of a line, a spline and an elliptical arc, placed, turned and scaled", () => {
    // Half an ellipse (radii 20 × 10) over a base whose middle dips as a cubic.
    const base: Curve2D = {
      kind: 'bspline',
      degree: 3,
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      poles: [{ x: -20, y: 0 }, { x: -10, y: -6 }, { x: 10, y: -6 }, { x: 20, y: 0 }],
    };
    const top: Curve2D = { kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 20, y: 0 }, ratio: 0.5, start: 0, end: Math.PI };
    const read = DxfReader.read(fileOf([base, top]));
    const m = Affine.placement(2, Math.PI / 3, { x: 100, y: -40 });
    const placed = read.entities.map((e) => Affine.curve(m, e.curve, 1e-9)!);
    const plan = SketchImport.plan(placed, { ...OPTIONS, tolerance: 1e-4 });
    expect(plan.approximated).toBe(1);
    const { volume, outcome } = extrudedVolume(plan, 1);
    expect(outcome).toBe('solved');
    // Half the ellipse, plus the dip under it: ∫ y dx along the cubic, with
    // y(t) = −18·t(1 − t) and x′(t) = 30·(1 + 2·t(1 − t)), is 540 · (1/6 + 2/30) = 126.
    // The placement doubles lengths, so the area is four times that.
    const area = (Math.PI * 20 * 10) / 2 + 126;
    expect(volume).toBeCloseTo(area * 4, 1);
  });

  it("extrudes a full ellipse and what a non-uniform block scale makes of a circle", () => {
    const text = [
      0, "SECTION", 2, "BLOCKS",
      0, "BLOCK", 8, "0", 2, "DISC", 70, 0, 10, 0, 20, 0,
      0, "CIRCLE", 8, "0", 10, 0, 20, 0, 40, 1,
      0, "ENDBLK",
      0, "ENDSEC",
      0, "SECTION", 2, "ENTITIES",
      0, "INSERT", 8, "0", 2, "DISC", 10, 50, 20, 0, 41, 6, 42, 3, 50, 30,
      0, "ENDSEC", 0, "EOF",
    ].join("\n");
    const plan = SketchImport.plan(DxfReader.read(text).entities.map((e) => e.curve), OPTIONS);
    expect(plan.primitives).toEqual([{ kind: 'ellipse', center: { x: 50, y: 0 }, rx: 6, ry: 3, rotation: 30 }]);
    const { volume } = extrudedVolume(plan, 1);
    expect(volume).toBeCloseTo(Math.PI * 6 * 3, 2);
  });
});
