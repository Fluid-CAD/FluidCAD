import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import { SvgReader } from "../../io/drawing/svg-reader.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import type { SketchImportPlan } from "../../io/drawing/sketch-import.js";
import { OPTIONS, extrudedVolume, solved } from "./sketch-plan.js";

// The import end to end, the way the sketch SVG tool runs it: a file read
// and flattened, its curves planned as sketch statements, and those
// statements written (`sketch-plan.ts`) then extruded. What this pins is
// that an SVG's outline — through its groups, transforms, references and
// the page's turned-over Y — encloses in the sketch the area it encloses on
// the page.

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const K = 0.5522847498;

/** A circle the way a program without arcs writes one: four cubic béziers. */
function bezierCircle(cx: number, cy: number, r: number): string {
  const k = r * K;
  return `M${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy}`
    + ` C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} Z`;
}

/** A 100 × 50 plate with corners rounded by 8, a hole of radius 5 drawn as béziers, and a 30 × 10 slot drawn with arcs. */
const PLATE_SHAPES = `<rect x="-50" y="-25" width="100" height="50" rx="8"/>
  <path d="${bezierCircle(-30, 0, 5)}"/>
  <path d="M 10 -5 h 20 a 5 5 0 0 1 0 10 h -20 a 5 5 0 0 1 0 -10 z"/>`;
const PLATE_AREA = 100 * 50 - (4 - Math.PI) * 64 - Math.PI * 25 - (20 * 10 + Math.PI * 25);

function planOf(text: string): SketchImportPlan {
  return SketchImport.plan(SvgReader.read(text).entities.map((e) => e.curve), OPTIONS);
}

describe("an SVG imported into a sketch", () => {
  setupOC();

  it("extrudes a plate drawn in a moved group: a rounded rectangle, a hole of béziers, a slot of arcs", () => {
    const text = `<svg ${NS} width="120mm" height="70mm" viewBox="0 0 120 70"><g fill="none" stroke="#000" transform="translate(60 35)">${PLATE_SHAPES}</g></svg>`;
    const read = SvgReader.read(text);
    expect(read.unit).toEqual({ name: 'mm', mm: 1 });
    const plan = planOf(text);
    // The rectangle's sides and corners, the hole as one circle, the slot's two lines and two half turns.
    expect(plan.primitives.map((p) => p.kind)).toEqual([
      'line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc', 'circle', 'line', 'arc', 'line', 'arc',
    ]);
    expect(plan.primitives[8]).toMatchObject({ kind: 'circle', center: { x: 30, y: 35 }, diameter: expect.closeTo(10, 2) });
    expect(plan.joins).toHaveLength(8 + 4);
    expect(plan.approximated).toBe(0);
    const { volume, outcome } = extrudedVolume(plan, 2);
    expect(outcome).toBe('solved');
    expect(volume / 2).toBeCloseTo(PLATE_AREA, 0);
  });

  it("extrudes the same plate mirrored, turned and doubled: every arc still bulges outward", () => {
    const text = `<svg ${NS} width="400mm" height="400mm" viewBox="0 0 400 400">
      <g transform="translate(200 200) rotate(30)"><g transform="scale(-2 2)" fill="none" stroke="#000">${PLATE_SHAPES}</g></g></svg>`;
    const plan = planOf(text);
    expect(plan.primitives.filter((p) => p.kind === 'arc')).toHaveLength(6);
    expect(plan.primitives.filter((p) => p.kind === 'circle')).toHaveLength(1);
    const { volume, outcome } = extrudedVolume(plan, 1);
    expect(outcome).toBe('solved');
    expect(volume).toBeCloseTo(PLATE_AREA * 4, -1);
  });

  it("extrudes a plate whose holes are one symbol drawn four times, on a page in tenths of a millimetre", () => {
    const text = `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="80mm" height="60mm" viewBox="0 0 800 600">
      <defs><symbol id="hole" viewBox="-1 -1 2 2"><circle r="1"/></symbol></defs>
      <rect x="100" y="100" width="600" height="400"/>
      <use xlink:href="#hole" x="150" y="150" width="60" height="60"/><use href="#hole" x="590" y="150" width="60" height="60"/>
      <use href="#hole" x="150" y="390" width="60" height="60"/><use href="#hole" x="590" y="390" width="60" height="60"/></svg>`;
    const read = SvgReader.read(text);
    expect(read.unit).toEqual({ name: '0.1 mm', mm: 0.1 });
    const plan = planOf(text);
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line', 'circle', 'circle', 'circle', 'circle']);
    // Each hole fills its 60-unit viewport: a diameter of 60, centred 30 in from the corner it is placed at.
    expect(plan.primitives[4]).toEqual({ kind: 'circle', center: { x: 180, y: 420 }, diameter: 60 });
    const { volume } = extrudedVolume(plan, 1);
    expect(volume).toBeCloseTo(600 * 400 - 4 * Math.PI * 900, 0);
  });

  it("extrudes the ellipse a circle becomes in a group scaled along one axis", () => {
    const plan = planOf(`<svg ${NS} width="100" height="100"><g transform="translate(50 50) rotate(-30) scale(3 1)"><circle r="4"/></g></svg>`);
    expect(plan.primitives).toEqual([{ kind: 'ellipse', center: { x: 50, y: 50 }, rx: 12, ry: 4, rotation: 30 }]);
    const { volume } = extrudedVolume(plan, 1);
    expect(volume).toBeCloseTo(Math.PI * 12 * 4, 2);
  });

  it("extrudes an outline of quadratic and cubic béziers as the same curves", () => {
    // A lens: a parabola over the X axis and a cubic under it, between (0, 50) and (40, 50) on the page.
    const text = `<svg ${NS} width="100" height="100"><path d="M0 50 Q20 10 40 50 C30 70 10 70 0 50 Z" fill="none" stroke="black"/></svg>`;
    const plan = planOf(text);
    expect(plan.primitives.map((p) => p.kind)).toEqual(['bezier', 'bezier']);
    expect(plan.joins).toHaveLength(2);
    const { volume, outcome } = extrudedVolume(plan, 1);
    expect(outcome).toBe('solved');
    // Under the parabola: two thirds of 40 × 20. Under the cubic: ∫ y dx with
    // y(t) = 60·t(1 − t) and x′(t) = −30·(1 + 2·t(1 − t)) is 1800 · (1/6 + 2/30) = 420.
    expect(volume).toBeCloseTo((2 / 3) * 40 * 20 + 420, 2);
  });

  it("fixes an imported plate in place: no freedom left, nothing stated twice", () => {
    const text = `<svg ${NS} width="120mm" height="70mm" viewBox="0 0 120 70"><g fill="none" stroke="#000" transform="translate(60 35)">${PLATE_SHAPES}</g></svg>`;
    expect(solved(planOf(text), true)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
    expect(solved(planOf(text), false)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
  });
});
