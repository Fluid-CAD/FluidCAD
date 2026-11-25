import { describe, it, expect } from "vitest";
import { render, setupOC } from "../setup.js";
import sketch from "../../core/sketch.js";
import { DxfReader } from "../../io/drawing/dxf-reader.js";
import { DxfWriter } from "../../io/drawing/dxf-writer.js";
import { Affine } from "../../io/drawing/affine.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import { ConstructionLines } from "../../io/drawing/construction-lines.js";
import { ImportedDrawings } from "../../io/drawing/import.js";
import type { SketchImportPlan } from "../../io/drawing/sketch-import.js";
import { Curves } from "../../io/drawing/drawing.js";
import type { Curve2D, DrawingEntity } from "../../io/drawing/drawing.js";
import { OPTIONS, draw, extrudedVolume, solved } from "./sketch-plan.js";

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
    const plan = SketchImport.plan(placed, OPTIONS);
    // Both as themselves: the cubic as a bezier, the half ellipse as an elliptical arc turned with the drawing.
    expect(plan.primitives.map((p) => p.kind)).toEqual(['bezier', 'eArc']);
    expect(plan.primitives[1]).toMatchObject({ ry: 20, rotation: 60 });
    expect(plan.approximated).toBe(0);
    const { volume, outcome } = extrudedVolume(plan, 1);
    expect(outcome).toBe('solved');
    // Half the ellipse, plus the dip under it: ∫ y dx along the cubic, with
    // y(t) = −18·t(1 − t) and x′(t) = 30·(1 + 2·t(1 − t)), is 540 · (1/6 + 2/30) = 126.
    // The placement doubles lengths, so the area is four times that.
    const area = (Math.PI * 20 * 10) / 2 + 126;
    expect(volume).toBeCloseTo(area * 4, 3);
  });

  describe("an elliptical arc", () => {
    /** A slice of an ellipse: the `ELLIPSE` entity of a file, and a line from each of its ends to its centre. */
    const slice = (ellipse: (string | number)[], centre: { x: number; y: number }): Curve2D[] => {
      const text = [0, "SECTION", 2, "ENTITIES", 0, "ELLIPSE", 8, "0", ...ellipse, 0, "ENDSEC", 0, "EOF"].join("\n");
      const arc = DxfReader.read(text).entities[0].curve;
      const [start, end] = Curves.endpoints(arc)!;
      return [arc, { kind: 'line', a: end, b: centre }, { kind: 'line', a: centre, b: start }];
    };
    // Centre (10, 5), radii 20 × 10, from parameter 0.4 to 2: a slice of 20 · 10 · 1.6 / 2 = 160.
    const ELLIPSE = [10, 10, 20, 5, 11, 20, 21, 0, 40, 0.5, 41, 0.4, 42, 2];
    const AREA = (20 * 10 * 1.6) / 2;

    it("extrudes a slice of an ellipse: the arc is the piece the file drew, not the rest of the ellipse", () => {
      const plan = SketchImport.plan(slice(ELLIPSE, { x: 10, y: 5 }), OPTIONS);
      expect(plan.primitives.map((p) => p.kind)).toEqual(['eArc', 'line', 'line']);
      expect(plan.joins).toHaveLength(3);
      expect(plan.approximated).toBe(0);
      const { volume, outcome } = extrudedVolume(plan, 2);
      expect(outcome).toBe('solved');
      expect(volume).toBeCloseTo(AREA * 2, 4);
    });

    it("extrudes the same slice from a drawing on a flipped plane: the arc turns the other way over the mirrored points", () => {
      // Seen from below (extrusion −Z) the parameter runs clockwise: the slice hangs under the long axis.
      const curves = slice([...ELLIPSE, 210, 0, 220, 0, 230, -1], { x: 10, y: 5 });
      expect(Curves.bounds(curves[0]).max.y).toBeLessThan(5);
      const plan = SketchImport.plan(curves, OPTIONS);
      expect(plan.primitives[0].kind).toBe('eArc');
      const { volume, outcome } = extrudedVolume(plan, 2);
      expect(outcome).toBe('solved');
      expect(volume).toBeCloseTo(AREA * 2, 4);
    });

    it("extrudes the slice placed, turned and scaled to numbers that do not round: its written ends still meet their lines", () => {
      const m = Affine.placement(1 / 3, 0.7, { x: 100 / 7, y: -40 / 9 });
      const placed = slice(ELLIPSE, { x: 10, y: 5 }).map((curve) => Affine.curve(m, curve, 1e-9)!);
      const plan = SketchImport.plan(placed, OPTIONS);
      const arc = plan.primitives[0];
      if (arc.kind !== 'eArc') {
        throw new Error(`expected an elliptical arc, got ${arc.kind}`);
      }
      // None of these numbers is round: the ends are rounded like the lines' ends they are written at.
      expect(arc.start).toEqual((plan.primitives[2] as { end: unknown }).end);
      expect(arc.end).toEqual((plan.primitives[1] as { start: unknown }).start);

      sketch("xy", () => draw(plan));
      const drawn = render().getAllSceneObjects();
      const built = drawn.find((o) => o.getType() === 'eArc')!.serialize() as { start: { x: number; y: number }; end: { x: number; y: number } };
      const lines = drawn.filter((o) => o.getType() === 'line').map((o) => o.serialize() as { start: { x: number; y: number }; end: { x: number; y: number } });
      expect(Math.hypot(built.end.x - lines[0].start.x, built.end.y - lines[0].start.y)).toBeLessThan(1e-9);
      expect(Math.hypot(built.start.x - lines[1].end.x, built.start.y - lines[1].end.y)).toBeLessThan(1e-9);
      // And nothing moved to get there: the arc is drawn at its written ends.
      expect(Math.hypot(built.start.x - arc.start.x, built.start.y - arc.start.y)).toBeLessThan(1e-9);
      expect(Math.hypot(built.end.x - arc.end.x, built.end.y - arc.end.y)).toBeLessThan(1e-9);
    });

    it("draws the arc's ends where they are written with no join to hold them: nearer than the kernel tells apart", () => {
      const m = Affine.placement(1 / 3, 0.7, { x: 100 / 7, y: -40 / 9 });
      const placed = slice(ELLIPSE, { x: 10, y: 5 }).map((curve) => Affine.curve(m, curve, 1e-9)!);
      const plan = SketchImport.plan(placed, OPTIONS);
      sketch("xy", () => draw(plan, [], false));
      const drawn = render().getAllSceneObjects();
      const built = drawn.find((o) => o.getType() === 'eArc')!.serialize() as { start: { x: number; y: number }; end: { x: number; y: number } };
      const lines = drawn.filter((o) => o.getType() === 'line').map((o) => o.serialize() as { start: { x: number; y: number }; end: { x: number; y: number } });
      expect(Math.hypot(built.end.x - lines[0].start.x, built.end.y - lines[0].start.y)).toBeLessThan(1e-9);
      expect(Math.hypot(built.start.x - lines[1].end.x, built.start.y - lines[1].end.y)).toBeLessThan(1e-9);
    });

    it("extrudes the placed slice when its joins are not written: the ends are close enough to close the profile", () => {
      const m = Affine.placement(1 / 3, 0.7, { x: 100 / 7, y: -40 / 9 });
      const placed = slice(ELLIPSE, { x: 10, y: 5 }).map((curve) => Affine.curve(m, curve, 1e-9)!);
      const apart = extrudedVolume(SketchImport.plan(placed, OPTIONS), 3, false);
      expect(apart.outcome).toBe('solved');
      expect(apart.volume).toBeCloseTo((AREA / 9) * 3, 4);
    });
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

    /** A piece of an ellipse of radii 20 × 8 about (13, −4): its long axis at `degrees`, from parameter `start` through `sweep`. */
    const ellipseArc = (degrees: number, start: number, sweep: number): Curve2D => ({
      kind: 'ellipse',
      center: { x: 13, y: -4 },
      major: { x: 20 * Math.cos(degrees * Math.PI / 180), y: 20 * Math.sin(degrees * Math.PI / 180) },
      ratio: 0.4,
      start,
      end: start + sweep,
    });
    /** The arc alone, and the arc with a line across its ends: what the joins then carry. */
    const alone = (arc: Curve2D) => SketchImport.plan([arc], OPTIONS);
    const closed = (arc: Curve2D) => {
      const [start, end] = Curves.endpoints(arc)!;
      return SketchImport.plan([arc, { kind: 'line', a: end, b: start }], OPTIONS);
    };
    /** What holds the plan's elliptical arc beside its two ends. */
    const held = (plan: SketchImportPlan) => SketchImport.pins(plan, { joined: false, decimals: 6 })
      .filter((pin) => (pin.kind === 'fix' ? pin.point.primitive === 0 && pin.point.point === 'center' : pin.primitive === 0));
    const QUARTER = Math.PI / 2;

    it("fixes an elliptical arc along a sketch axis by its ends, its centre and that axis", () => {
      for (const [degrees, direction] of [[0, 'horizontal'], [90, 'vertical']] as const) {
        const arc = ellipseArc(degrees, 0, QUARTER);
        expect(held(alone(arc))).toEqual([
          { kind: 'fix', point: { primitive: 0, point: 'center' } },
          { kind: 'level', primitive: 0, direction },
        ]);
        expect(solved(alone(arc), false)).toEqual(FIXED);
        expect(solved(closed(arc), true)).toEqual(FIXED);
      }
    });

    it("holds half an ellipse, whose centre is on its chord, by its other radius and where the centre sits across the chord", () => {
      // From one end of the long axis to the other: the ends say how long that axis is and where its middle is along it, no more.
      const arc = ellipseArc(0, 0, Math.PI);
      expect(held(alone(arc))).toEqual([
        { kind: 'semi-radius', primitive: 0, axis: 'y', value: 8 },
        { kind: 'aligned', primitive: 0, direction: 'horizontal' },
        { kind: 'level', primitive: 0, direction: 'horizontal' },
      ]);
      expect(solved(alone(arc), false)).toEqual(FIXED);
      expect(solved(closed(arc), true)).toEqual(FIXED);
    });

    it("fixes a level elliptical arc of any sweep, from a sliver to nearly all the way round", () => {
      for (const degrees of [0, 90]) {
        for (const start of [0, 0.3, 1.1, QUARTER, 2.5, Math.PI, 4, 5.5]) {
          for (const sweep of [0.02, 0.2, 1, QUARTER, 2.2, Math.PI, 4, 3 * QUARTER, 5.9, 6.27]) {
            const arc = ellipseArc(degrees, start, sweep);
            expect(solved(alone(arc), false), `${degrees}° from ${start} through ${sweep}`).toEqual(FIXED);
            expect(solved(closed(arc), true), `${degrees}° from ${start} through ${sweep}, joined`).toEqual(FIXED);
          }
        }
      }
    });

    it("fixes a turned elliptical arc by its centre and a semi-radius: the ends hold its angle", () => {
      const arc = ellipseArc(30, 0.4, 1.6);
      expect(held(alone(arc))).toEqual([
        { kind: 'fix', point: { primitive: 0, point: 'center' } },
        { kind: 'semi-radius', primitive: 0, axis: 'x', value: expect.closeTo(20, 5) },
      ]);
      for (const degrees of [30, -47.3, 3]) {
        for (const start of [0.3, 1.1, 2.5, 4, 5.5]) {
          for (const sweep of [0.02, 0.2, 1, QUARTER, 2.2, Math.PI, 4, 3 * QUARTER, 5.9, 6.27]) {
            const turned = ellipseArc(degrees, start, sweep);
            expect(solved(alone(turned), false), `${degrees}° from ${start} through ${sweep}`).toEqual(FIXED);
            expect(solved(closed(turned), true), `${degrees}° from ${start} through ${sweep}, joined`).toEqual(FIXED);
          }
        }
      }
    });

    it("fixes a turned elliptical arc with one end on its ellipse's axis: the other end holds its angle", () => {
      for (const sweep of [1, 2.2, 4]) {
        expect(solved(alone(ellipseArc(30, 0, sweep)), false)).toEqual(FIXED);
        expect(solved(closed(ellipseArc(30, QUARTER, sweep)), true)).toEqual(FIXED);
      }
    });

    it("leaves a turned elliptical arc that runs between its ellipse's own axes its angle, and nothing else", () => {
      // A quarter from vertex to vertex: turning the ellipse about its centre moves neither end off it.
      expect(held(alone(ellipseArc(30, 0, QUARTER)))).toEqual([{ kind: 'fix', point: { primitive: 0, point: 'center' } }]);
      for (const start of [0, QUARTER, Math.PI]) {
        for (const sweep of [QUARTER, Math.PI, 3 * QUARTER]) {
          const arc = ellipseArc(30, start, sweep);
          expect(solved(alone(arc), false), `from ${start} through ${sweep}`).toEqual({ ...FIXED, dof: 1 });
          expect(solved(closed(arc), true), `from ${start} through ${sweep}, joined`).toEqual({ ...FIXED, dof: 1 });
        }
      }
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
  // A 40 × 20 plate laid out by its two centre lines and a ray from its first corner through the opposite one.
  const laidOutPlate = (): SketchImportPlan => {
    const text = [
      0, "SECTION", 2, "ENTITIES",
      0, "LWPOLYLINE", 8, "PLATE", 90, 4, 70, 1, 10, 0, 20, 0, 10, 40, 20, 0, 10, 40, 20, 20, 10, 0, 20, 20,
      0, "XLINE", 8, "LAYOUT", 10, 0, 20, 10, 11, 1, 21, 0,
      0, "XLINE", 8, "LAYOUT", 10, 20, 20, 0, 11, 0, 21, 1,
      0, "RAY", 8, "LAYOUT", 10, 0, 20, 0, 11, 2 / Math.sqrt(5), 21, 1 / Math.sqrt(5),
      0, "ENDSEC", 0, "EOF",
    ].join("\n");
    const read = DxfReader.read(text);
    const curves = read.entities.map((e) => e.curve);
    const guides = ConstructionLines.segments(read.constructionLines, ImportedDrawings.bounds(curves));
    return SketchImport.plan(curves, OPTIONS, [], { guides });
  };

  it("cuts construction lines to a little past the drawing: across it, and a ray from its start", () => {
    const guides = laidOutPlate().primitives.filter((p) => SketchImport.isGuide(p));
    // The frame is the plate and a tenth of its longer side: −4…44 by −4…24.
    expect(guides).toEqual([
      { kind: 'line', start: { x: -4, y: 10 }, end: { x: 44, y: 10 }, guide: true },
      { kind: 'line', start: { x: 20, y: -4 }, end: { x: 20, y: 24 }, guide: true },
      // The ray leaves the corner along (2, 1) and stops beside the frame's far corner (44, 24).
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 44.8, y: 22.4 }, guide: true },
    ]);
  });

  it("draws construction lines as guide lines, which the sketch keeps out of the profile it extrudes", () => {
    const plan = laidOutPlate();
    expect(plan.joins).toHaveLength(4);
    const { volume, outcome } = extrudedVolume(plan, 2);
    expect(outcome).toBe('solved');
    expect(volume).toBeCloseTo(40 * 20 * 2, 6);
  });

  it("marks the lines it draws for construction lines as guides, and no other", () => {
    const plan = laidOutPlate();
    sketch("xy", () => draw(plan));
    const lines = render().getAllSceneObjects().filter((o) => o.getType() === 'line');
    expect(lines.map((line) => line.isGuide())).toEqual([false, false, false, false, true, true, true]);
  });

  it("fixes guide lines in place with the outline: no freedom left, nothing stated twice", () => {
    const plan = laidOutPlate();
    expect(solved(plan, true)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
    expect(solved(plan, false)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
  });

  it("fixes construction lines that are all a file holds", () => {
    const text = [
      0, "SECTION", 2, "ENTITIES",
      0, "XLINE", 8, "0", 10, 0, 20, 0, 11, 1, 21, 0,
      0, "XLINE", 8, "0", 10, 0, 20, 0, 11, 0, 21, 1,
      0, "ENDSEC", 0, "EOF",
    ].join("\n");
    const guides = ConstructionLines.segments(DxfReader.read(text).constructionLines, null);
    const plan = SketchImport.plan([], OPTIONS, [], { guides });
    expect(plan.primitives).toEqual([
      { kind: 'line', start: { x: -50, y: 0 }, end: { x: 50, y: 0 }, guide: true },
      { kind: 'line', start: { x: 0, y: -50 }, end: { x: 0, y: 50 }, guide: true },
    ]);
    expect(solved(plan, true)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
  });
});
