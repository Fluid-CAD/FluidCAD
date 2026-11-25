import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { DxfReader } from "../../io/drawing/dxf-reader.js";
import { DxfWriter } from "../../io/drawing/dxf-writer.js";
import { Affine } from "../../io/drawing/affine.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import type { SketchImportPlan } from "../../io/drawing/sketch-import.js";
import { Curves } from "../../io/drawing/drawing.js";
import type { Curve2D, DrawingEntity } from "../../io/drawing/drawing.js";
import { OPTIONS, extrudedVolume, solved } from "./sketch-plan.js";

// The import end to end, the way the sketch DXF tool runs it: a file read,
// its curves planned as sketch statements, and those statements written
// (`sketch-plan.ts`) then extruded. What this pins is that the plan's
// geometry means the same thing to the sketch as it did to the file: an arc
// turns the way it turned, ends meet.

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

  describe("fixed in place", () => {
    const planOf = (text: string) => SketchImport.plan(DxfReader.read(text).entities.map((e) => e.curve), OPTIONS);
    const file = (...entities: (string | number)[]) => [0, "SECTION", 2, "ENTITIES", ...entities, 0, "ENDSEC", 0, "EOF"].join("\n");
    const FIXED = { outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 };
    const b = Math.tan(Math.PI / 8);

    // A plate with quarter-turn corners, a slot of two half turns, and a hole.
    const PLATE = file(
      0, "LWPOLYLINE", 8, "0", 90, 8, 70, 1,
      10, -52, 20, -35, 10, 52, 20, -35, 42, b, 10, 60, 20, -27, 10, 60, 20, 27, 42, b,
      10, 52, 20, 35, 10, -52, 20, 35, 42, b, 10, -60, 20, 27, 10, -60, 20, -27, 42, b,
      0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1, 10, -14, 20, -6, 10, 14, 20, -6, 42, 1, 10, 14, 20, 6, 10, -14, 20, 6, 42, 1,
      0, "CIRCLE", 8, "0", 10, 48, 20, 23, 40, 3,
    );

    it("leaves a joined outline no freedom, and states nothing twice", () => {
      const plan = planOf(PLATE);
      const pins = SketchImport.pins(plan, { joined: true, decimals: 6 });
      // A corner's radius holds it; a half turn's does not, so its centre is held across its chord.
      expect(pins.filter((p) => p.kind === 'radius')).toHaveLength(4);
      // Here each centre is straight above or below its arc's start: a vertical pair.
      expect(pins.filter((p) => p.kind === 'aligned')).toEqual([
        { kind: 'aligned', primitive: 9, direction: 'vertical' },
        { kind: 'aligned', primitive: 11, direction: 'vertical' },
      ]);
      expect(pins.some((p) => p.kind === 'offset')).toBe(false);
      // One fix per meeting point (twelve corners), and the hole's centre.
      expect(pins.filter((p) => p.kind === 'fix')).toHaveLength(13);
      expect(solved(plan, true)).toEqual(FIXED);
    });

    it("fixes every end on its own when the joins are not written", () => {
      const plan = planOf(PLATE);
      const pins = SketchImport.pins(plan, { joined: false, decimals: 6 });
      expect(pins.filter((p) => p.kind === 'fix')).toHaveLength(12 * 2 + 1);
      expect(solved(plan, false)).toEqual(FIXED);
    });

    it("fixes the same plate turned off the axes: half turns whose chords run askew", () => {
      const m = Affine.placement(1.5, 0.4, { x: 30, y: -12 });
      const placed = DxfReader.read(PLATE).entities.map((e) => Affine.curve(m, e.curve, 1e-9)!);
      const plan = SketchImport.plan(placed, OPTIONS);
      // Askew, the centre is a measured distance off its arc's start along the axis nearest the chord's normal.
      const offsets = SketchImport.pins(plan, { joined: true, decimals: 6 }).filter((p) => p.kind === 'offset');
      expect(offsets).toHaveLength(2);
      expect(offsets.every((p) => p.kind === 'offset' && p.axis === 'x' && p.value > 0)).toBe(true);
      expect(solved(plan, true)).toEqual(FIXED);
    });

    it("fixes beziers by every control point, and arcs of every sweep", () => {
      const curves: Curve2D[] = [
        { kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: 11, y: -3 }, { x: 16, y: 8 }, { x: 22, y: 1 }] },
        { kind: 'ellipse', center: { x: 40, y: 0 }, major: { x: 12, y: 0 }, ratio: 0.5, start: 0, end: Math.PI },
        ...[0.3, 1.2, 2.6, 3.0, Math.PI, 3.3, 4.5, 6.0].map((sweep, i): Curve2D => ({
          kind: 'arc', center: { x: i * 30, y: 60 }, radius: 10, start: 0.7 * i, end: 0.7 * i + sweep,
        })),
      ];
      expect(solved(SketchImport.plan(curves, OPTIONS), true)).toEqual(FIXED);
    });

    it("leaves a turned ellipse its angle, the one thing no constraint holds, and an upright one nothing", () => {
      const ellipseAt = (degrees: number): Curve2D => ({
        kind: 'ellipse', center: { x: 0, y: 0 },
        major: { x: 10 * Math.cos(degrees * Math.PI / 180), y: 10 * Math.sin(degrees * Math.PI / 180) },
        ratio: 0.4, start: 0, end: 2 * Math.PI,
      });
      expect(solved(SketchImport.plan([ellipseAt(0)], OPTIONS), true)).toEqual(FIXED);
      expect(solved(SketchImport.plan([ellipseAt(90)], OPTIONS), true)).toEqual(FIXED);
      expect(solved(SketchImport.plan([ellipseAt(30)], OPTIONS), true)).toEqual({ ...FIXED, dof: 1 });
    });
  });

  // A 40 × 20 plate, a drill centre near each end, and a datum mark on its first corner.
  const drilledPlate = (): SketchImportPlan => {
    const text = [
      0, "SECTION", 2, "ENTITIES",
      0, "LWPOLYLINE", 8, "PLATE", 90, 4, 70, 1, 10, 0, 20, 0, 10, 40, 20, 0, 10, 40, 20, 20, 10, 0, 20, 20,
      0, "POINT", 8, "DRILL", 10, 8, 20, 10,
      0, "POINT", 8, "DRILL", 10, 32, 20, 10,
      0, "POINT", 8, "DATUM", 10, 0, 20, 0,
      0, "ENDSEC", 0, "EOF",
    ].join("\n");
    const read = DxfReader.read(text);
    return SketchImport.plan(read.entities.map((e) => e.curve), OPTIONS, read.points.map((p) => p.at));
  };

  it("brings a drill pattern in as points beside the outline, which extrudes as it did", () => {
    const plan = drilledPlate();
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line', 'point', 'point', 'point']);
    // The four corners, and the datum mark on the first of them.
    expect(plan.joins).toHaveLength(4 + 1);
    const { volume, outcome } = extrudedVolume(plan, 2);
    expect(outcome).toBe('solved');
    expect(volume).toBeCloseTo(40 * 20 * 2, 6);
  });

  it("fixes imported points in place with the outline: no freedom left, nothing stated twice", () => {
    const plan = drilledPlate();
    expect(solved(plan, true)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
    expect(solved(plan, false)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
  });
});
