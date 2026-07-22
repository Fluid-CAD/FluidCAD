import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import fillet from "../../core/fillet.js";
import { rect, polygon, slot, circle, hLine, aLine, move } from "../../core/2d/index.js";
import { Rect } from "../../features/2d/rect.js";
import { Edge } from "../../common/edge.js";
import { SceneObject } from "../../common/scene-object.js";
import { synthesizeSketchApplyFeature } from "../../selection/sketch-apply.js";
import { setLocation } from "./pick-helpers.js";

// Stage 3 (plans/sketch-edge-selection): the 2D branch of the selection
// kernel — {shapeId} picks resolve through the sketch edge index and
// synthesize construction-relative selectors, verified generate-and-test.
describe("sketch apply-feature synthesis", () => {
  setupOC();

  const edgesOf = (obj: SceneObject): Edge[] =>
    obj.getShapes().filter((s): s is Edge => s instanceof Edge);

  const refFor = (edge: Edge) => ({ shapeId: edge.id });

  const roleEdge = (obj: SceneObject, role: string, roleIndex?: number): Edge => {
    const match = edgesOf(obj).find(e => e.role === role
      && (roleIndex === undefined || e.roleIndex === roleIndex));
    expect(match).toBeDefined();
    return match!;
  };

  it("walking skeleton: rect side + adjacent line → r.edge('top'), l", () => {
    let r: Rect;
    let l: SceneObject;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
      move([0, 60]);
      l = aLine(135, 30) as unknown as SceneObject;
    });
    const scene = render();
    setLocation(r!, 3);
    setLocation(l!, 5);

    const result = synthesizeSketchApplyFeature(
      scene,
      [refFor(roleEdge(r!, 'top')), refFor(edgesOf(l!)[0])],
      'fillet',
      4,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe("r.edge('top'), l");
    expect(result.preview).toBe("fillet(4, r.edge('top'), l)");
    expect(result.spec.feature).toBe('fillet');
    expect(result.spec.value).toBe(4);
    expect(result.spec.producers).toEqual([
      { line: 3, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
      { line: 5, column: 0, featureType: 'line', nameHint: 'l', bind: true },
    ]);
    expect(result.spec.parts).toEqual([
      { producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" },
      { producer: 1, accessor: '', indices: null, filterArgs: null },
    ]);
    expect(result.spec.imports).toEqual([]);
  });

  it("disambiguates repeated roles with roleIndex", () => {
    let pg: SceneObject;
    let sl: SceneObject;
    sketch("xy", () => {
      pg = polygon(6, 60) as unknown as SceneObject;
      move([100, 0]);
      sl = slot(80, 15) as unknown as SceneObject;
    });
    const scene = render();
    setLocation(pg!, 3);
    setLocation(sl!, 5);

    const result = synthesizeSketchApplyFeature(
      scene,
      [refFor(roleEdge(pg!, 'side', 2)), refFor(roleEdge(sl!, 'cap-arc', 0))],
      'fillet',
      2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe("pg.edge('side', 2), sl.edge('cap-arc', 0)");
  });

  it("collapses a whole-owner pick to the bare variable", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
    });
    const scene = render();
    setLocation(r!, 3);

    const result = synthesizeSketchApplyFeature(
      scene, edgesOf(r!).map(refFor), 'fillet', 6,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe('r');
    expect(result.preview).toBe('fillet(6, r)');
  });

  it("keeps role accessors when the owner is partially consumed", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80) as Rect;
      fillet(2, r.edge('right'), r.edge('top'));
    });
    const scene = render();
    setLocation(r!, 3);

    // The picks cover everything r STILL owns (left + bottom — the earlier
    // fillet consumed right + top), but not r as built. The bare variable
    // would verify today yet silently widen to all four sides if the earlier
    // fillet were removed — role accessors must win.
    const result = synthesizeSketchApplyFeature(
      scene,
      [refFor(roleEdge(r!, 'left')), refFor(roleEdge(r!, 'bottom'))],
      'fillet',
      2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe("r.edge('bottom'), r.edge('left')");
    expect(result.alternatives).toContain('r');
  });

  it("offers the index form as a verified alternative", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
    });
    const scene = render();
    setLocation(r!, 3);

    const result = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'fillet', 4,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe("r.edge('top')");
    expect(result.alternatives).toContain('r.edge(2)');
  });

  it("falls back to an edge filter for shared call sites", () => {
    let h1: SceneObject;
    let h2: SceneObject;
    sketch("xy", () => {
      h1 = hLine(30) as unknown as SceneObject;
      move([0, 20]);
      h2 = hLine(40) as unknown as SceneObject;
    });
    const scene = render();
    // Same call site: a loop or helper executed the statement twice.
    setLocation(h1!, 4);
    setLocation(h2!, 4);

    const result = synthesizeSketchApplyFeature(
      scene, [refFor(edgesOf(h1!)[0])], 'fillet', 3,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe('edge().line(30)');
    expect(result.spec.producers).toEqual([
      { line: 4, column: 0, featureType: 'line', nameHint: 'l', bind: false },
    ]);
    expect(result.spec.parts).toEqual([
      { producer: null, accessor: 'filter', indices: null, filterArgs: 'edge().line(30)' },
    ]);
    expect(result.spec.imports).toEqual(['edge']);
  });

  it("narrows a filter by dimension when the kind alone is ambiguous", () => {
    let c1: SceneObject;
    let c2: SceneObject;
    sketch("xy", () => {
      c1 = circle(40) as unknown as SceneObject;
      move([100, 0]);
      c2 = circle(20) as unknown as SceneObject;
    });
    const scene = render();
    // Same call site: both circles come from one looped statement.
    setLocation(c1!, 4);
    setLocation(c2!, 4);

    const result = synthesizeSketchApplyFeature(
      scene, [refFor(edgesOf(c1!)[0])], 'fillet', 2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe('edge().circle(40)');
  });

  it("refuses picks spanning different sketches", () => {
    let r1: Rect;
    let r2: Rect;
    sketch("xy", () => {
      r1 = rect(80, 60) as Rect;
    });
    sketch("xz", () => {
      r2 = rect(40, 30) as Rect;
    });
    const scene = render();
    setLocation(r1!, 3);
    setLocation(r2!, 7);

    const result = synthesizeSketchApplyFeature(
      scene,
      [refFor(roleEdge(r1!, 'top')), refFor(roleEdge(r2!, 'top'))],
      'fillet',
      4,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different sketches/),
    });
  });

  it("refuses picks that do not resolve to sketch edges", () => {
    sketch("xy", () => {
      rect(80, 60);
    });
    const scene = render();

    const result = synthesizeSketchApplyFeature(
      scene, [{ shapeId: 'nope' }], 'fillet', 4,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not resolve/),
    });
  });
});
