import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import { line, hLine, aLine, arc, tArc } from "../../core/2d/index.js";
import { Edge } from "../../common/edge.js";
import { SceneObject } from "../../common/scene-object.js";
import { listSegmentConversions, ConversionOption } from "../../selection/segment-conversion.js";
import { Move } from "../../features/2d/move.js";
import { setLocation } from "./pick-helpers.js";

// Sketcher Phase 2a: the segment-conversion engine's analysis half — which
// constrained/free conversions a picked chained segment supports, with the
// fully rendered replacement statement for each.
describe("listSegmentConversions", () => {
  setupOC();

  const refFor = (obj: unknown) => {
    const edge = (obj as SceneObject).getShapes().find((s): s is Edge => s instanceof Edge);
    expect(edge).toBeDefined();
    return { shapeId: edge!.id };
  };

  const optionFor = (options: ConversionOption[] | undefined, target: string): ConversionOption => {
    const option = options?.find(o => o.target === target);
    expect(option, `expected a ${target} option`).toBeDefined();
    return option!;
  };

  it("first free segment: aLine, hLine and vLine all convert at any angle", () => {
    let l: unknown;
    sketch("xy", () => {
      l = line([100, 100]);
    });
    const scene = render();
    setLocation(l, 3);

    const result = listSegmentConversions(scene, refFor(l));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('line-two-points');
    expect(result.sourceLocation).toMatchObject({ line: 3 });

    const a = optionFor(result.options, 'aLine');
    expect(a.enabled).toBe(true);
    expect(a.newStatement).toBe('aLine(45, 141.42)');

    // Axis snaps convert at any angle — the endpoint moves onto the axis
    // and endpointDelta carries the move size for the UI to warn about.
    const h = optionFor(result.options, 'hLine');
    expect(h.enabled).toBe(true);
    expect(h.newStatement).toBe('hLine(100)');
    expect(h.endpointDelta).toBeCloseTo(100, 5);

    const v = optionFor(result.options, 'vLine');
    expect(v.enabled).toBe(true);
    expect(v.newStatement).toBe('vLine(100)');
    expect(v.endpointDelta).toBeCloseTo(100, 5);

    // tLine keeps the tangency tolerance: 45° off the incoming tangent.
    const t = optionFor(result.options, 'tLine');
    expect(t.enabled).toBe(false);
    expect(t.reason).toContain('5°');

    expect(result.options!.some(o => o.target === 'free')).toBe(false);
  });

  it("axis snaps refuse only degenerate extents (pure vertical → hLine)", () => {
    let l: unknown;
    sketch("xy", () => {
      l = line([0, 80]);
    });
    const scene = render();
    setLocation(l, 3);

    const result = listSegmentConversions(scene, refFor(l));
    expect(result.ok).toBe(true);

    const h = optionFor(result.options, 'hLine');
    expect(h.enabled).toBe(false);
    expect(h.reason).toContain('no horizontal extent');

    const v = optionFor(result.options, 'vLine');
    expect(v.enabled).toBe(true);
    expect(v.newStatement).toBe('vLine(80)');
    expect(v.endpointDelta).toBeCloseTo(0, 5);
  });

  it("anti-parallel tLine converts with negative length", () => {
    let l1: unknown;
    let l2: unknown;
    sketch("xy", () => {
      l1 = line([100, 0]);
      l2 = line([50, 0]);
    });
    const scene = render();
    setLocation(l1, 3);
    setLocation(l2, 4);

    const result = listSegmentConversions(scene, refFor(l2));
    expect(result.ok).toBe(true);
    expect(optionFor(result.options, 'tLine').newStatement).toBe('tLine(-50)');
    expect(optionFor(result.options, 'hLine').newStatement).toBe('hLine(-50)');
    expect(optionFor(result.options, 'aLine').newStatement).toBe('aLine(180, 50)');
  });

  it("explicit-start line converts with the start preserved and an absolute angle", () => {
    let l: unknown;
    sketch("xy", () => {
      l = line([10, 10], [60, 60]);
    });
    const scene = render();
    setLocation(l, 3);
    // In production the statement's internal Move sibling carries the same
    // source line — it must not read as a conflicting statement.
    for (const obj of scene.getAllSceneObjects()) {
      if (obj instanceof Move) {
        setLocation(obj, 3);
      }
    }

    const result = listSegmentConversions(scene, refFor(l));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('line-two-points');

    expect(optionFor(result.options, 'aLine')).toMatchObject({
      enabled: true,
      newStatement: 'aLine([10, 10], 45, 70.71)',
    });
    expect(optionFor(result.options, 'hLine')).toMatchObject({
      enabled: true,
      newStatement: 'hLine([10, 10], 50)',
    });
    expect(optionFor(result.options, 'vLine')).toMatchObject({
      enabled: true,
      newStatement: 'vLine([10, 10], 50)',
    });

    // tLine has no explicit-start form — it always continues the chain.
    const t = optionFor(result.options, 'tLine');
    expect(t.enabled).toBe(false);
    expect(t.reason).toContain('own start point');
  });

  it("explicit-start aLine builds from its start with an absolute angle and reverses", () => {
    let a: unknown;
    sketch("xy", () => {
      a = aLine([10, 10], 30, 50);
    });
    const scene = render();
    setLocation(a, 3);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('aline');
    expect(optionFor(result.options, 'free')).toMatchObject({
      enabled: true,
      newStatement: 'line([10, 10], [53.3, 35])',
    });
    expect(optionFor(result.options, 'hLine').newStatement).toBe('hLine([10, 10], 43.3)');
  });

  it("refuses when another statement shares the source line", () => {
    let l: unknown;
    let a: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      a = arc([200, 100]).center([100, 100]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(a, 3);

    const result = listSegmentConversions(scene, refFor(l));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('own line');
  });

  it("hLine offers the other line forms plus the free door, never itself", () => {
    let h: unknown;
    sketch("xy", () => {
      h = hLine(50);
    });
    const scene = render();
    setLocation(h, 3);

    const result = listSegmentConversions(scene, refFor(h));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('hline');
    expect(result.options!.some(o => o.target === 'hLine')).toBe(false);

    expect(optionFor(result.options, 'aLine')).toMatchObject({
      enabled: true,
      newStatement: 'aLine(0, 50)',
    });
    expect(optionFor(result.options, 'tLine')).toMatchObject({
      enabled: true,
      newStatement: 'tLine(50)',
    });
    expect(optionFor(result.options, 'vLine').enabled).toBe(false);
    expect(optionFor(result.options, 'free')).toMatchObject({
      enabled: true,
      newStatement: 'line([50, 0])',
    });
  });

  it("aLine converts to vLine and back through the free door", () => {
    let a: unknown;
    sketch("xy", () => {
      a = aLine(90, 50);
    });
    const scene = render();
    setLocation(a, 3);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('aline');
    expect(result.options!.some(o => o.target === 'aLine')).toBe(false);
    expect(optionFor(result.options, 'vLine')).toMatchObject({
      enabled: true,
      newStatement: 'vLine(50)',
    });
    expect(optionFor(result.options, 'hLine').enabled).toBe(false);
    expect(optionFor(result.options, 'free').newStatement).toBe('line([0, 50])');
  });

  it("chained tangent-continuous arc converts to tArc", () => {
    let l: unknown;
    let a: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      a = arc([200, 100]).center([100, 100]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(a, 4);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('arc');
    expect(result.options).toHaveLength(1);
    expect(result.options![0]).toMatchObject({
      target: 'tArc',
      enabled: true,
      newStatement: 'tArc(100, [200, 100])',
    });
    expect(result.options![0].reshapeAngle).toBeUndefined();
  });

  it("non-tangent arc converts to tArc with a reshape warning", () => {
    let l: unknown;
    let a: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      a = arc([200, 100]).center([150, 50]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(a, 4);

    // Endpoints are preserved — the arc re-bulges to tangency — so the
    // conversion is legal at any start angle; reshapeAngle carries the
    // deviation for the UI to warn about.
    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    const option = result.options![0];
    expect(option).toMatchObject({
      target: 'tArc',
      enabled: true,
      // The written radius is the tangent-solved one for the preserved
      // endpoint — not the original arc's radius.
      newStatement: 'tArc(100, [200, 100])',
    });
    expect(option.reshapeAngle).toBeCloseTo(45, 1);
  });

  it("arc chained after tArc segments converts at any start angle", () => {
    let a: unknown;
    sketch('xy', () => {
      hLine(15.67);
      aLine(90, 20.76);
      tArc(8.9);
      tArc(-2);
      a = arc([-15.57, 29.96]).center([-4.87, 24.52]);
    });
    const scene = render();
    let lineNo = 3;
    for (const obj of scene.getAllSceneObjects()) {
      setLocation(obj, lineNo++);
    }

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    const option = result.options![0];
    expect(option).toMatchObject({
      target: 'tArc',
      enabled: true,
      newStatement: 'tArc(10.24, [-15.57, 29.96])',
    });
    expect(option.reshapeAngle).toBeCloseTo(36.5, 0);
  });

  it("arc whose endpoint lies along the incoming tangent refuses tArc", () => {
    let l: unknown;
    let a: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      a = arc([200, 0]).center([150, 0]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(a, 4);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    const option = result.options![0];
    expect(option.target).toBe('tArc');
    expect(option.enabled).toBe(false);
    expect(option.reason).toContain('tangent arc cannot reach it');
  });

  it("refuses the angles-form arc (its chain anchor is the center)", () => {
    let l: unknown;
    let a: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      a = arc(50, 0, 90);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(a, 4);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('continue the chain');
  });

  it("tArc reverses to arc().center() with orientation", () => {
    let l: unknown;
    let ccw: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      ccw = tArc([200, 100]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(ccw, 4);

    const result = listSegmentConversions(scene, refFor(ccw));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('tarc-to-point');
    expect(result.options![0].newStatement).toBe('arc([200, 100]).center([100, 100])');
  });

  it("clockwise tArc reverses with .cw()", () => {
    let l: unknown;
    let cw: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      cw = tArc([200, -100]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(cw, 4);

    const result = listSegmentConversions(scene, refFor(cw));
    expect(result.ok).toBe(true);
    expect(result.options![0].newStatement).toBe('arc([200, -100]).center([100, -100]).cw()');
  });

  it("tarc-radius-to-point offers only the free-arc conversion", () => {
    let l: unknown;
    let t: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      // The aim point is off the radius-150 tangent circle — the built end
      // is its projection onto the circle at (234.16, 82.92).
      t = tArc(150, [200, 100]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(t, 4);

    const result = listSegmentConversions(scene, refFor(t));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('tarc-radius-to-point');

    // Already a tangent arc — no tArc button; only the free-arc door out.
    expect(result.options!.some(o => o.target === 'tArc')).toBe(false);
    expect(result.options).toHaveLength(1);
    const free = optionFor(result.options, 'free');
    expect(free.enabled).toBe(true);
    expect(free.newStatement).toBe('arc([234.16, 82.92]).center([100, 150])');
  });

  it("refuses picks that are not sketch segments", () => {
    sketch("xy", () => {
      line([100, 0]);
    });
    const scene = render();

    const result = listSegmentConversions(scene, { shapeId: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not resolve');
  });
});
