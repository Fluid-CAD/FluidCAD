import { describe, it, expect } from "vitest";
import { SvgPathData } from "../../../io/drawing/svg-path.js";
import { PathSegments } from "../../../io/drawing/path-segments.js";
import type { PathSegment, Subpath } from "../../../io/drawing/path-segments.js";
import { SvgValues } from "../../../io/drawing/svg-values.js";
import { Affine } from "../../../io/drawing/affine.js";
import { Curves } from "../../../io/drawing/drawing.js";
import type { Curve2D, Vec2 } from "../../../io/drawing/drawing.js";
import { SvgOracle } from "./svg-oracle.js";

function expectPoint(actual: Vec2, expected: Vec2 | [number, number], digits = 9): void {
  const [x, y] = Array.isArray(expected) ? expected : [expected.x, expected.y];
  expect(actual.x).toBeCloseTo(x, digits);
  expect(actual.y).toBeCloseTo(y, digits);
}

/** `count + 1` points along a segment, evenly spaced in its own parameter. */
function sample(segment: PathSegment, count: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    switch (segment.kind) {
      case 'line':
        points.push({ x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t });
        break;
      case 'conic':
        points.push(PathSegments.conicPoint(segment, segment.t0 + (segment.t1 - segment.t0) * t));
        break;
      case 'bezier': {
        const work = segment.points.map((p) => ({ ...p }));
        for (let level = work.length - 1; level > 0; level--) {
          for (let k = 0; k < level; k++) {
            work[k] = { x: work[k].x + (work[k + 1].x - work[k].x) * t, y: work[k].y + (work[k + 1].y - work[k].y) * t };
          }
        }
        points.push(work[0]);
      }
    }
  }
  return points;
}

const segmentsOf = (d: string): PathSegment[] => SvgPathData.parse(d).subpaths.flatMap((s) => s.segments);

describe("SvgPathData: against the format's own definition of each command", () => {
  // The oracle reads upper-case commands by the SVG grammar and samples an arc from its ends, radii and flags.
  const paths = [
    "M 10 10 L 40 12 L 35 40 Z",
    "M 0 0 C 10 20 30 20 40 0 Q 50 -20 60 0",
    "M 50 50 A 30 20 25 0 1 90 70",
    "M 50 50 A 30 20 25 1 0 90 70",
    "M 50 50 A 30 20 -40 0 0 90 70 A 30 20 -40 1 1 50 50",
    "M 0 0 A 5 5 0 0 1 100 0",
    "M 10 80 A 45 45 0 1 0 10 79.5 Z",
  ];
  for (const d of paths) {
    it(d, () => {
      const expected = SvgOracle.segments(d).filter((s) => s.from.x !== s.to.x || s.from.y !== s.to.y);
      const actual = segmentsOf(d);
      expect(actual).toHaveLength(expected.length);
      expected.forEach((segment, i) => {
        const points = SvgOracle.sample(segment, 12);
        sample(actual[i], 12).forEach((p, k) => expectPoint(p, points[k], 7));
      });
    });
  }
});

describe("SvgPathData: the grammar as files write it", () => {
  it("resolves relative commands, and reads a relative move that opens the path from the origin", () => {
    const [a, b, c] = segmentsOf("m 10 10 l 5 0 h 5 v -5");
    expect(a).toEqual({ kind: 'line', a: { x: 10, y: 10 }, b: { x: 15, y: 10 } });
    expect(b).toEqual({ kind: 'line', a: { x: 15, y: 10 }, b: { x: 20, y: 10 } });
    expect(c).toEqual({ kind: 'line', a: { x: 20, y: 10 }, b: { x: 20, y: 5 } });
  });

  it("takes numbers run together: signs, second decimal points, exponents, no space after a letter", () => {
    const lines = segmentsOf("M10-20L1.5.5-3-4l1e1,2E-1 5.,5.");
    const ends: [number, number][] = [[1.5, 0.5], [-3, -4], [7, -3.8], [12, 1.2]];
    expect(lines).toHaveLength(ends.length);
    lines.forEach((line, i) => expectPoint((line as { b: Vec2 }).b, ends[i], 12));
  });

  it("draws a line to each further pair of a move, and repeats a command left without its letter", () => {
    const { subpaths } = SvgPathData.parse("M0 0 10 0 10 10 m5 5 5 0 0 5 C0 0 1 1 2 2 3 3 4 4 5 5");
    // The béziers carry on the subpath the second move opened.
    expect(subpaths.map((s) => s.segments.map((seg) => seg.kind))).toEqual([['line', 'line'], ['line', 'line', 'bezier', 'bezier']]);
    expect((subpaths[1].segments[1] as { b: Vec2 }).b).toEqual({ x: 20, y: 20 });
  });

  it("reads arc flags with nothing after them", () => {
    const packed = segmentsOf("M0 0a10 10 0 0110 10a10 10 0 10-10-10");
    const spaced = segmentsOf("M0 0 a10 10 0 0 1 10 10 a10 10 0 1 0 -10 -10");
    expect(packed).toHaveLength(2);
    expect(packed).toEqual(spaced);
  });

  it("mirrors the last control point for S and T, and takes the pen itself after any other command", () => {
    const [, s, lone] = segmentsOf("M0 0 C0 10 10 10 10 0 S20 -10 20 0 M0 50 S10 60 20 50") as Extract<PathSegment, { kind: 'bezier' }>[];
    expect(s.points[1]).toEqual({ x: 10, y: -10 });
    expect(lone.points[1]).toEqual({ x: 0, y: 50 });
    const [, t, after] = segmentsOf("M0 0 Q5 10 10 0 T20 0 L30 0 T40 0") as Extract<PathSegment, { kind: 'bezier' }>[];
    expect(t.points[1]).toEqual({ x: 15, y: -10 });
    // After a line there is nothing to mirror: the control point is the pen, and the curve a straight run.
    expect(segmentsOf("M0 0 Q5 10 10 0 T20 0 L30 0 T40 0")[3]).toEqual({ kind: 'bezier', points: [{ x: 30, y: 0 }, { x: 30, y: 0 }, { x: 40, y: 0 }] });
    expect(after).toBeDefined();
  });

  it("closes a subpath with the line back to its start, and starts the next one there", () => {
    const { subpaths } = SvgPathData.parse("M10 10 h10 v10 z l-5 -5 M0 0 h1 Z");
    expect(subpaths.map((s) => s.closed)).toEqual([true, false, true]);
    expect(subpaths[0].segments[2]).toEqual({ kind: 'line', a: { x: 20, y: 20 }, b: { x: 10, y: 10 } });
    expect(subpaths[1].segments[0]).toEqual({ kind: 'line', a: { x: 10, y: 10 }, b: { x: 5, y: 5 } });
    // Already back at the start: nothing is added to get there.
    expect(SvgPathData.parse("M0 0 L10 0 L0 0 Z").subpaths[0].segments).toHaveLength(2);
  });

  it("draws nothing for a move alone, a segment of no length, or no data", () => {
    expect(SvgPathData.parse("M10 10").subpaths).toEqual([]);
    expect(SvgPathData.parse("M10 10 L10 10 Z").subpaths).toEqual([]);
    expect(SvgPathData.parse("").subpaths).toEqual([]);
    expect(SvgPathData.parse("   ").error).toBe(false);
  });

  it("draws up to the command with an error, and says there was one", () => {
    const short = SvgPathData.parse("M 10,10 L 20,20,30");
    expect(short.error).toBe(true);
    expect(short.subpaths[0].segments).toEqual([{ kind: 'line', a: { x: 10, y: 10 }, b: { x: 20, y: 20 } }]);
    const unknown = SvgPathData.parse("M0 0 L10 0 X 5 5 L20 20");
    expect(unknown.error).toBe(true);
    expect(unknown.subpaths[0].segments).toHaveLength(1);
    expect(SvgPathData.parse("L 10 10").error).toBe(true);
    expect(SvgPathData.parse("L 10 10").subpaths).toEqual([]);
    expect(SvgPathData.parse("M0 0 A 10 10 0 2 1 20 0").subpaths).toEqual([]);
  });
});

describe("SvgPathData.arc: what the format says of odd arcs", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 10, y: 0 };

  it("is the straight line for a radius of zero, and nothing between two ends that are one point", () => {
    expect(SvgPathData.arc(from, 0, 5, 0, false, true, to)).toEqual({ kind: 'line', a: from, b: to });
    expect(SvgPathData.arc(from, 5, 0, 0, false, true, to)).toEqual({ kind: 'line', a: from, b: to });
    expect(SvgPathData.arc(from, 5, 5, 0, true, true, { x: 0, y: 0 })).toBeNull();
  });

  it("grows radii too small to span the ends into the half turn that just does", () => {
    const arc = SvgPathData.arc(from, 1, 1, 0, false, true, to) as Extract<PathSegment, { kind: 'conic' }>;
    expectPoint(arc.center, [5, 0]);
    expect(Math.hypot(arc.u.x, arc.u.y)).toBeCloseTo(5, 12);
    expect(arc.t1 - arc.t0).toBeCloseTo(Math.PI, 12);
  });

  it("takes a negative radius as its size", () => {
    expect(SvgPathData.arc(from, -8, 8, 0, false, true, to)).toEqual(SvgPathData.arc(from, 8, 8, 0, false, true, to));
  });

  it("starts and ends exactly on its two ends, whichever of the four arcs the flags pick", () => {
    for (const large of [false, true]) {
      for (const sweep of [false, true]) {
        const arc = SvgPathData.arc({ x: 3, y: 4 }, 30, 12, 37, large, sweep, { x: 25, y: -6 })!;
        expectPoint(PathSegments.start(arc), [3, 4], 10);
        expectPoint(PathSegments.end(arc), [25, -6], 10);
        const turned = (arc as { t1: number; t0: number }).t1 - (arc as { t0: number }).t0;
        expect(turned > Math.PI).toBe(large);
      }
    }
  });
});

describe("SvgValues.transform", () => {
  const at = (text: string, p: [number, number]): Vec2 => Affine.point(SvgValues.transform(text)!, { x: p[0], y: p[1] });

  it("reads each function of the attribute", () => {
    expectPoint(at("translate(10, 5)", [1, 2]), [11, 7]);
    expectPoint(at("translate(10)", [1, 2]), [11, 2]);
    expectPoint(at("scale(2)", [1, 2]), [2, 4]);
    expectPoint(at("scale(2 -3)", [1, 2]), [2, -6]);
    expectPoint(at("rotate(90)", [1, 0]), [0, 1]);
    expectPoint(at("rotate(90, 10, 10)", [11, 10]), [10, 11]);
    expectPoint(at("skewX(45)", [0, 1]), [1, 1]);
    expectPoint(at("skewY(45)", [1, 0]), [1, 1]);
    expectPoint(at("matrix(1 2 3 4 5 6)", [1, 1]), [1 + 3 + 5, 2 + 4 + 6]);
  });

  it("applies a list right to left: what is written last acts first", () => {
    expectPoint(at("translate(10 0) scale(2)", [1, 1]), [12, 2]);
    expectPoint(at("scale(2) translate(10 0)", [1, 1]), [22, 2]);
    expectPoint(at("translate(5,5)rotate(90),scale(2 1)", [1, 0]), [5, 7]);
  });

  it("reads the CSS spellings: units, single-axis functions, 3D forms that stay flat", () => {
    expectPoint(at("rotate(0.25turn)", [1, 0]), [0, 1]);
    expectPoint(at("rotate(1.5707963267948966rad)", [1, 0]), [0, 1]);
    expectPoint(at("rotate(100grad)", [1, 0]), [0, 1]);
    expectPoint(at("translate(1in, 10px)", [0, 0]), [96, 10]);
    expectPoint(at("translateX(5px) translateY(7px) scaleX(2) scaleY(3)", [1, 1]), [7, 10]);
    expectPoint(at("skew(45deg, 0deg)", [0, 1]), [1, 1]);
    expectPoint(at("translate3d(4px, 5px, 0) translateZ(0) scale3d(2, 2, 1) rotateZ(0deg)", [1, 1]), [6, 7]);
    expectPoint(at("matrix3d(2,0,0,0, 0,3,0,0, 0,0,1,0, 10,20,0,1)", [1, 1]), [12, 23]);
    expect(SvgValues.transform("none")).toEqual(Affine.IDENTITY);
    expect(SvgValues.transform("   ")).toEqual(Affine.IDENTITY);
  });

  it("is null for what is not a transform in the plane", () => {
    for (const text of ["rotate(45", "translate(10 20 30)", "scale()", "matrix(1 2 3)", "spin(4)", "rotateX(30deg)", "perspective(100px)",
      "translate(10%, 0)", "translate(1 2) nonsense", "rotate(a)", "matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0.01, 0,0,0,1)"]) {
      expect(SvgValues.transform(text), text).toBeNull();
    }
  });
});

describe("SvgValues: view boxes and lengths", () => {
  const corners = (aspect: string, width: number, height: number) => {
    const m = SvgValues.viewportTransform({ x: 10, y: 20, width: 100, height: 50 }, SvgValues.aspect(aspect), width, height);
    return [Affine.point(m, { x: 10, y: 20 }), Affine.point(m, { x: 110, y: 70 })];
  };

  it("fits a view box inside its viewport and centres it, by default", () => {
    // 100 × 50 into 400 × 400: four times, with 100 of room above and below.
    const [a, b] = corners("", 400, 400);
    expectPoint(a, [0, 100]);
    expectPoint(b, [400, 300]);
  });

  it("aligns the box where preserveAspectRatio says", () => {
    expectPoint(corners("xMinYMin meet", 400, 400)[0], [0, 0]);
    expectPoint(corners("xMaxYMax meet", 400, 400)[0], [0, 200]);
    expectPoint(corners("xMinYMax", 400, 400)[1], [400, 400]);
    // Sliced: scaled to cover, eight times, the overflow shared out by the alignment.
    expectPoint(corners("xMidYMid slice", 400, 400)[0], [-200, 0]);
    expectPoint(corners("xMinYMid slice", 400, 400)[0], [0, 0]);
    expectPoint(corners("xMaxYMid slice", 400, 400)[1], [400, 400]);
  });

  it("stretches each axis on its own for none", () => {
    const [a, b] = corners("none", 400, 400);
    expectPoint(a, [0, 0]);
    expectPoint(b, [400, 400]);
    expect(SvgValues.aspect("none slice").uniform).toBe(false);
  });

  it("reads a view box of four numbers with an area, and no other", () => {
    expect(SvgValues.viewBox("0 0 100 50")).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(SvgValues.viewBox(" -5,-5,10,1e1 ")).toEqual({ x: -5, y: -5, width: 10, height: 10 });
    for (const text of ["0 0 100", "0 0 0 50", "0 0 100 -50", "a b c d", ""]) {
      expect(SvgValues.viewBox(text), text).toBeNull();
    }
    expect(SvgValues.viewBox(undefined)).toBeNull();
  });

  it("reads lengths with their units, and lists up to their first error", () => {
    expect(SvgValues.length("12.5mm")).toEqual({ value: 12.5, unit: "mm" });
    expect(SvgValues.length(" 3e1 PX ")).toEqual({ value: 30, unit: "px" });
    expect(SvgValues.length("1em")).toEqual({ value: 1, unit: "em" });
    expect(SvgValues.length("50%")).toEqual({ value: 50, unit: "%" });
    expect(SvgValues.length(".5")).toEqual({ value: 0.5, unit: "" });
    expect(SvgValues.length("10.")).toEqual({ value: 10, unit: "" });
    expect(SvgValues.length("auto")).toBeNull();
    expect(SvgValues.length("1 2")).toBeNull();
    expect(SvgValues.numbers("0,0 10,0\n10,10 x 5 5")).toEqual([0, 0, 10, 0, 10, 10]);
    expect(SvgValues.numbers("1-2.5.5")).toEqual([1, -2.5, 0.5]);
    const units = SvgValues.unitFactors(96);
    expect(units.in).toBe(96);
    expect(units.mm * 25.4).toBeCloseTo(96, 12);
    expect(units.pt * 72).toBeCloseTo(96, 12);
    expect(units.pc).toBe(16);
    expect(units.cm).toBeCloseTo(units.mm * 10, 12);
    expect(units.q * 4).toBeCloseTo(units.mm, 12);
  });
});

describe("PathSegments.arcOf: the circle a bezier stands for", () => {
  /** The cubic programs draw an arc with: handles 4/3·tan(θ/4) radii long along the end tangents. */
  const arcBezier = (center: Vec2, radius: number, from: number, sweep: number): PathSegment => {
    const reach = (4 / 3) * Math.tan(sweep / 4) * radius;
    const to = from + sweep;
    const on = (angle: number): Vec2 => ({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
    const p0 = on(from);
    const p3 = on(to);
    return {
      kind: 'bezier',
      points: [
        p0,
        { x: p0.x - reach * Math.sin(from), y: p0.y + reach * Math.cos(from) },
        { x: p3.x + reach * Math.sin(to), y: p3.y - reach * Math.cos(to) },
        p3,
      ],
    };
  };

  it("finds the arc of a quarter-turn bezier: its centre, radius and both ends, exactly", () => {
    const bezier = arcBezier({ x: 30, y: -12 }, 25, 0.4, Math.PI / 2);
    const arc = PathSegments.arcOf(bezier)!;
    expect(arc).not.toBeNull();
    expect(Math.hypot(arc.center.x - 30, arc.center.y + 12)).toBeLessThan(25 * 3e-4);
    expect(Math.hypot(arc.u.x, arc.u.y)).toBeCloseTo(25, 1);
    expect(arc.t1 - arc.t0).toBeCloseTo(Math.PI / 2, 3);
    expectPoint(PathSegments.start(arc), (bezier as { points: Vec2[] }).points[0], 12);
    expectPoint(PathSegments.end(arc), (bezier as { points: Vec2[] }).points[3], 11);
  });

  it("finds arcs of any sweep up to the widest a cubic can follow, turning either way", () => {
    for (const sweep of [0.05, 0.3, 1, Math.PI / 2, 1.8, -0.3, -Math.PI / 2]) {
      const arc = PathSegments.arcOf(arcBezier({ x: 0, y: 0 }, 10, 1, sweep));
      expect(arc, `sweep ${sweep}`).not.toBeNull();
      expect(arc!.t1 - arc!.t0).toBeCloseTo(Math.abs(sweep), 3);
      // The parameter grows the way the bezier is drawn.
      expectPoint(PathSegments.conicPoint(arc!, (arc!.t0 + arc!.t1) / 2), [10 * Math.cos(1 + sweep / 2), 10 * Math.sin(1 + sweep / 2)], 2);
    }
    // Past a third of a turn the best cubic strays more than a thousandth of the radius: not taken for the arc.
    expect(PathSegments.arcOf(arcBezier({ x: 0, y: 0 }, 10, 0, 2.2))).toBeNull();
    expect(PathSegments.arcOf(arcBezier({ x: 0, y: 0 }, 10, 0, Math.PI))).toBeNull();
  });

  it("leaves a bezier that is not a circle's alone", () => {
    const not: Vec2[][] = [
      // A quarter of an ellipse a hundredth off round.
      (arcBezier({ x: 0, y: 0 }, 10, 0, Math.PI / 2) as { points: Vec2[] }).points.map((p) => ({ x: p.x, y: p.y * 0.99 })),
      // A shallow curve with lopsided handles: near some large circle everywhere, on none.
      [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 60, y: 1.2 }, { x: 100, y: 0 }],
      // An S: it turns both ways.
      [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: -10 }, { x: 30, y: 0 }],
      // Straight.
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }],
      // A loop back onto its start.
      [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: -10, y: 10 }, { x: 0, y: 0 }],
    ];
    for (const points of not) {
      expect(PathSegments.arcOf({ kind: 'bezier', points })).toBeNull();
    }
    expect(PathSegments.arcOf({ kind: 'bezier', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }] })).toBeNull();
    expect(PathSegments.arcOf({ kind: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } })).toBeNull();
  });

  it("still finds the arc when the file rounded its numbers to three decimals", () => {
    const exact = arcBezier({ x: 12.3456, y: 7.891 }, 8, 0.2, Math.PI / 2) as { points: Vec2[] };
    const rounded = exact.points.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
    expect(PathSegments.arcOf({ kind: 'bezier', points: rounded })).not.toBeNull();
  });
});

describe("PathSegments.joined: pieces of one circle put back together", () => {
  const curvesOf = (d: string, arcs = true): Curve2D[] => SvgPathData.parse(d).subpaths.flatMap((subpath: Subpath) =>
    PathSegments.joined(subpath, { arcs }).segments.map((segment) => PathSegments.curve(segment, 1e-9)!));

  it("reads a circle drawn as two half arcs as the circle", () => {
    const [circle, ...rest] = curvesOf("M 10 50 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0 Z");
    expect(rest).toEqual([]);
    expect(circle.kind).toBe('circle');
    expectPoint((circle as { center: Vec2 }).center, [50, 50]);
    expect((circle as { radius: number }).radius).toBeCloseTo(40, 9);
  });

  it("reads a circle drawn as four beziers as the circle, and not with recognition off", () => {
    const k = 0.5522847498;
    const d = `M150 100 C150 ${100 + 50 * k} ${100 + 50 * k} 150 100 150 C${100 - 50 * k} 150 50 ${100 + 50 * k} 50 100`
      + ` C50 ${100 - 50 * k} ${100 - 50 * k} 50 100 50 C${100 + 50 * k} 50 150 ${100 - 50 * k} 150 100 Z`;
    const [circle, ...rest] = curvesOf(d);
    expect(rest).toEqual([]);
    expect(circle.kind).toBe('circle');
    expectPoint((circle as { center: Vec2 }).center, [100, 100], 2);
    expect((circle as { radius: number }).radius).toBeCloseTo(50, 1);
    expect(curvesOf(d, false).map((c) => c.kind)).toEqual(['bspline', 'bspline', 'bspline', 'bspline']);
  });

  it("makes one arc of arcs that carry on along one circle, keeping its two ends where they were", () => {
    // Three thirds of a 240° arc, as the drawing export writes one.
    const on = (degrees: number) => `${(20 * Math.cos(degrees * Math.PI / 180)).toFixed(7)} ${(20 * Math.sin(degrees * Math.PI / 180)).toFixed(7)}`;
    const curves = curvesOf(`M ${on(10)} A 20 20 0 0 1 ${on(90)} A 20 20 0 0 1 ${on(170)} A 20 20 0 0 1 ${on(250)}`);
    expect(curves).toHaveLength(1);
    const arc = curves[0] as Extract<Curve2D, { kind: 'arc' }>;
    expect(arc.kind).toBe('arc');
    expect(arc.end - arc.start).toBeCloseTo((240 * Math.PI) / 180, 6);
    const [start, end] = Curves.endpoints(arc)!;
    expectPoint(start, [20 * Math.cos(10 * Math.PI / 180), 20 * Math.sin(10 * Math.PI / 180)], 6);
    expectPoint(end, [20 * Math.cos(250 * Math.PI / 180), 20 * Math.sin(250 * Math.PI / 180)], 6);
  });

  it("joins a closed outline's last arc to its first when the outline starts mid-arc", () => {
    // A stadium started in the middle of its right-hand half circle.
    const curves = curvesOf("M 30 0 A 10 10 0 0 1 20 10 L 0 10 A 10 10 0 0 1 0 -10 L 20 -10 A 10 10 0 0 1 30 0 Z");
    expect(curves.map((c) => c.kind)).toEqual(['arc', 'line', 'arc', 'line']);
    expect((curves[0] as { end: number }).end - (curves[0] as { start: number }).start).toBeCloseTo(Math.PI, 9);
  });

  it("keeps apart arcs of different circles, arcs that turn back, and arcs with a line between them", () => {
    expect(curvesOf("M 0 0 A 10 10 0 0 1 10 10 A 12 12 0 0 1 22 22").map((c) => c.kind)).toEqual(['arc', 'arc']);
    expect(curvesOf("M 0 0 A 10 10 0 0 1 10 10 A 10 10 0 0 0 0 0").map((c) => c.kind)).toEqual(['arc', 'arc']);
    expect(curvesOf("M 10 0 A 10 10 0 0 1 0 10 L 0 10.5 L 0 10 A 10 10 0 0 1 -10 0").map((c) => c.kind)).toEqual(['arc', 'line', 'line', 'arc']);
  });

  it("closes an ellipse drawn as two arcs into the ellipse, and leaves a part of one in its pieces", () => {
    const [ellipse, ...rest] = curvesOf("M 10 50 a 40 20 0 1 0 80 0 a 40 20 0 1 0 -80 0 Z");
    expect(rest).toEqual([]);
    expect(ellipse).toMatchObject({ kind: 'ellipse', ratio: expect.closeTo(0.5, 12), start: 0, end: 2 * Math.PI });
    expect(curvesOf("M 90 50 A 40 20 0 0 1 50 70 A 40 20 0 0 1 10 50").map((c) => c.kind)).toEqual(['ellipse', 'ellipse']);
  });

  it("takes every segment through a map exactly: a circle under a shear is the ellipse it becomes", () => {
    const m = SvgValues.transform("translate(5 5) skewX(30) scale(2 1)")!;
    const circle: PathSegment = { kind: 'conic', center: { x: 0, y: 0 }, u: { x: 10, y: 0 }, v: { x: 0, y: 10 }, t0: 0, t1: 2 * Math.PI };
    const mapped = PathSegments.map(m, circle);
    const curve = PathSegments.curve(mapped, 1e-9)!;
    expect(curve.kind).toBe('ellipse');
    // Every point of the circle, mapped, lies on the curve.
    const sampled = Curves.sample(curve, 720);
    for (let i = 0; i < 12; i++) {
      const p = Affine.point(m, { x: 10 * Math.cos(i), y: 10 * Math.sin(i) });
      expect(Math.min(...sampled.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))).toBeLessThan(0.1);
    }
    expect(PathSegments.isFinite(mapped)).toBe(true);
    expect(PathSegments.isFinite(PathSegments.map({ a: NaN, b: 0, c: 0, d: 1, e: 0, f: 0 }, circle))).toBe(false);
  });
});
