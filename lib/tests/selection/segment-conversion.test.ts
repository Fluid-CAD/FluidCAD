import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import { line, hLine, aLine, arc, tArc } from "../../core/2d/index.js";
import { Edge } from "../../common/edge.js";
import { SceneObject } from "../../common/scene-object.js";
import { listSegmentConversions, ConversionOption } from "../../selection/segment-conversion.js";
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

  it("first free segment: aLine always converts, off-axis snaps disabled", () => {
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

    for (const target of ['hLine', 'vLine', 'tLine']) {
      const option = optionFor(result.options, target);
      expect(option.enabled).toBe(false);
      expect(option.reason).toContain('5°');
    }
    expect(result.options!.some(o => o.target === 'free')).toBe(false);
  });

  it("snap tolerance boundary: 4.9° converts, 5.1° refuses", () => {
    let near: unknown;
    let far: unknown;
    sketch("xy", () => {
      near = line([100, 8.57]);
      far = line([200, 17.51]);
    });
    const scene = render();
    setLocation(near, 3);
    setLocation(far, 4);

    const nearResult = listSegmentConversions(scene, refFor(near));
    expect(nearResult.ok).toBe(true);
    const nearH = optionFor(nearResult.options, 'hLine');
    expect(nearH.enabled).toBe(true);
    expect(nearH.newStatement).toBe('hLine(100)');
    expect(nearH.endpointDelta).toBeCloseTo(8.57, 5);

    const farResult = listSegmentConversions(scene, refFor(far));
    expect(farResult.ok).toBe(true);
    const farH = optionFor(farResult.options, 'hLine');
    expect(farH.enabled).toBe(false);
    expect(farH.reason).toContain('5.1°');
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

  it("refuses explicit-start segments", () => {
    let l: unknown;
    sketch("xy", () => {
      l = line([10, 10], [60, 60]);
    });
    const scene = render();
    setLocation(l, 3);

    const result = listSegmentConversions(scene, refFor(l));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('continue the chain');
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

  it("hLine offers the free reverse door", () => {
    let h: unknown;
    sketch("xy", () => {
      h = hLine(50);
    });
    const scene = render();
    setLocation(h, 3);

    const result = listSegmentConversions(scene, refFor(h));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('hline');
    expect(result.options).toHaveLength(1);
    expect(result.options![0]).toMatchObject({
      target: 'free',
      enabled: true,
      newStatement: 'line([50, 0])',
    });
  });

  it("aLine offers the free reverse door", () => {
    let a: unknown;
    sketch("xy", () => {
      a = aLine(90, 50);
    });
    const scene = render();
    setLocation(a, 3);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    expect(result.currentKind).toBe('aline');
    expect(result.options![0].newStatement).toBe('line([0, 50])');
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
      newStatement: 'tArc([200, 100])',
    });
  });

  it("non-tangent arc refuses the tArc conversion with a reason", () => {
    let l: unknown;
    let a: unknown;
    sketch("xy", () => {
      l = line([100, 0]);
      a = arc([200, 100]).center([150, 50]);
    });
    const scene = render();
    setLocation(l, 3);
    setLocation(a, 4);

    const result = listSegmentConversions(scene, refFor(a));
    expect(result.ok).toBe(true);
    const option = result.options![0];
    expect(option.target).toBe('tArc');
    expect(option.enabled).toBe(false);
    expect(option.reason).toContain('5°');
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
