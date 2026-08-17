import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import fillet from "../../core/fillet.js";
import copy from "../../core/copy.js";
import { rect, polygon, slot, circle, hLine, aLine, line, move } from "../../core/2d/index.js";
import { Rect } from "../../features/2d/rect.js";
import { Edge } from "../../common/edge.js";
import { SceneObject } from "../../common/scene-object.js";
import { synthesizeSketchApplyFeature, resolveSketchStatementTargets } from "../../selection/sketch-apply.js";
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
      'offset',
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
      scene, [refFor(roleEdge(r!, 'top'))], 'offset', 4,
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
      scene, [refFor(edgesOf(h1!)[0])], 'offset', 3,
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
      scene, [refFor(edgesOf(c1!)[0])], 'offset', 2,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe('edge().circle(40)');
  });

  it("synthesizes an offset statement with the same selector ladder", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
    });
    const scene = render();
    setLocation(r!, 3);

    const result = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'offset', 3,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe("r.edge('top')");
    expect(result.preview).toBe("offset(3, r.edge('top'))");
    expect(result.spec.feature).toBe('offset');
    expect(result.spec.offset).toEqual({ removeOriginal: false, close: false });
  });

  it("carries the offset toggles into the statement it previews", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
    });
    const scene = render();
    setLocation(r!, 3);

    const removed = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'offset', 3,
      { offset: { removeOriginal: true, close: false } },
    );
    expect(removed).toMatchObject({
      ok: true,
      preview: "offset(3, true, r.edge('top'))",
      spec: { offset: { removeOriginal: true, close: false } },
    });

    const closed = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'offset', 3,
      { offset: { removeOriginal: false, close: true } },
    );
    expect(closed).toMatchObject({
      ok: true,
      preview: "offset(3, r.edge('top')).close()",
      spec: { offset: { removeOriginal: false, close: true } },
    });

    // The toggles are offset's own — a fillet never grows the extra argument.
    const filleted = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top')), refFor(roleEdge(r!, 'left'))], 'fillet', 3,
      { offset: { removeOriginal: true, close: false } },
    );
    expect(filleted).toMatchObject({ ok: true, spec: { offset: undefined } });
    if (filleted.ok) {
      expect(filleted.preview).toBe(`fillet(3, ${filleted.args})`);
    }
  });

  it("hints instead of no-opping when fillet picks share no corner", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
    });
    const scene = render();
    setLocation(r!, 3);

    // Opposite sides never touch — Fillet2D would silently do nothing.
    const opposite = synthesizeSketchApplyFeature(
      scene,
      [refFor(roleEdge(r!, 'top')), refFor(roleEdge(r!, 'bottom'))],
      'fillet',
      4,
    );
    expect(opposite).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/do not touch/),
    });

    // A single edge has no corner either.
    const single = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'fillet', 4,
    );
    expect(single).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/single edge has no corner/),
    });

    // The same single-edge pick offsets fine — the hint is fillet-only.
    const offsetSingle = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'offset', 2,
    );
    expect(offsetSingle.ok).toBe(true);
  });

  it("accepts fillet picks whose corner endpoints only nearly meet", () => {
    // Hand-drawn corners routinely miss by a few hundredths while looking
    // exactly shared — adjacency uses the same size-proportional tolerance
    // Fillet2D chains with, so the check and the apply agree.
    let a: SceneObject;
    let b: SceneObject;
    sketch("xy", () => {
      a = line([0, 0], [30, 0]) as unknown as SceneObject;
      b = line([30.005, 0.003], [45, 25]) as unknown as SceneObject;
    });
    const scene = render();
    setLocation(a!, 3);
    setLocation(b!, 4);

    const result = synthesizeSketchApplyFeature(
      scene,
      [refFor(edgesOf(a!)[0]), refFor(edgesOf(b!)[0])],
      'fillet',
      4,
    );
    expect(result.ok).toBe(true);
  });

  it("synthesizes a valueless trim statement from the selector ladder", () => {
    let r: Rect;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
    });
    const scene = render();
    setLocation(r!, 3);

    const result = synthesizeSketchApplyFeature(
      scene, [refFor(roleEdge(r!, 'top'))], 'trim',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.args).toBe("r.edge('top')");
    expect(result.preview).toBe("trim(r.edge('top'))");
    expect(result.spec.feature).toBe('trim');
    expect(result.spec.value).toBeUndefined();
  });

  describe("2D booleans (owner-level operands)", () => {
    it("fuses the picked edges' owners as bare variables", () => {
      let r: Rect;
      let c: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([60, 30]);
        c = circle(40) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(c!, 5);

      // One edge each — a pick stands for its whole producing geometry.
      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top')), refFor(edgesOf(c!)[0])],
        'fuse',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('r, c');
      expect(result.preview).toBe('fuse(r, c)');
      expect(result.spec.feature).toBe('fuse');
      expect(result.spec.value).toBeUndefined();
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: '', indices: null, filterArgs: null },
        { producer: 1, accessor: '', indices: null, filterArgs: null },
      ]);
    });

    it("dedupes multiple picks of the same owner", () => {
      let r: Rect;
      let c: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([60, 30]);
        c = circle(40) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top')), refFor(roleEdge(r!, 'left')), refFor(edgesOf(c!)[0])],
        'common',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('common(r, c)');
    });

    it("slots subtract picks into base and tool", () => {
      let r: Rect;
      let c: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([60, 30]);
        c = circle(40) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top'))],
        'subtract',
        undefined,
        { toolRefs: [refFor(edgesOf(c!)[0])] },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('subtract(r, c)');
      expect(result.spec.producers.map(p => p.featureType)).toEqual(['rect', 'circle']);
    });

    it("refuses boolean shapes the ops cannot take", () => {
      let r: Rect;
      let c1: SceneObject;
      let c2: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([60, 30]);
        c1 = circle(40) as unknown as SceneObject;
        move([160, 30]);
        c2 = circle(30) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(c1!, 5);
      setLocation(c2!, 7);

      // Fuse of a single geometry.
      expect(synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'fuse',
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/at least two/) });

      // Subtract without a tool slot.
      expect(synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'subtract',
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/tool geometry/) });

      // Subtract with two base geometries.
      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top')), refFor(edgesOf(c1!)[0])],
        'subtract',
        undefined,
        { toolRefs: [refFor(edgesOf(c2!)[0])] },
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/one base and one tool/) });

      // Base and tool picks landing on the same geometry.
      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top'))],
        'subtract',
        undefined,
        { toolRefs: [refFor(roleEdge(r!, 'left'))] },
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/same geometry/) });
    });

    it("narrows same-copy picks to instance operands", () => {
      let cp: SceneObject;
      sketch("xy", () => {
        const c = circle(40);
        cp = copy("linear", "x", { count: 3, offset: 30 }, c) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(cp!, 4);

      // Slots 0..2 in grid order — the original block first.
      const edges = edgesOf(cp!);
      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(edges[0]), refFor(edges[1])],
        'fuse',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('cp.instance(0), cp.instance(1)');
      expect(result.preview).toBe('fuse(cp.instance(0), cp.instance(1))');
      expect(result.spec.producers).toEqual([
        { line: 4, column: 0, featureType: 'copy-linear', nameHint: 'cp', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: 'instance', indices: [0], filterArgs: null },
        { producer: 0, accessor: 'instance', indices: [1], filterArgs: null },
      ]);
    });

    it("mixes an instance operand with a whole-owner operand", () => {
      let r: Rect;
      let cp: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([120, 0]);
        const c = circle(40);
        cp = copy("linear", "x", { count: 2, offset: 30 }, c) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(cp!, 6);

      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top')), refFor(edgesOf(cp!)[1])],
        'fuse',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('fuse(r, cp.instance(1))');
    });

    it("slots subtract picks into two instances of one copy", () => {
      let cp: SceneObject;
      sketch("xy", () => {
        const r = rect(20, 20);
        cp = copy("linear", "x", { count: 2, offset: 15 }, r) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(cp!, 4);

      // 8 edges: the original rect's 4 (slot 0), then slot 1's 4.
      const edges = edgesOf(cp!);

      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(edges[0])],
        'subtract',
        undefined,
        { toolRefs: [refFor(edges[4])] },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('subtract(cp.instance(0), cp.instance(1))');

      // Base and tool landing on the SAME slot is still the same geometry.
      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(edges[0])],
        'subtract',
        undefined,
        { toolRefs: [refFor(edges[1])] },
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/same geometry/) });

      // Two picks inside one slot are ONE operand — not enough to fuse.
      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(edges[0]), refFor(edges[1])],
        'fuse',
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/at least two/) });
    });

    it("refuses unbindable boolean operands honestly", () => {
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
        scene,
        [refFor(edgesOf(c1!)[0]), refFor(edgesOf(c2!)[0])],
        'fuse',
      );
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/call site produces multiple statements/),
      });
    });
  });

  describe("slot from edge (owner-level source)", () => {
    it("renders the picked edge's owner as the bare source variable", () => {
      let l: SceneObject;
      sketch("xy", () => {
        l = hLine(60) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(l!)[0])], 'slot', 10,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('l');
      expect(result.preview).toBe('slot(l, 10)');
      expect(result.spec.feature).toBe('slot');
      expect(result.spec.value).toBe(10);
      expect(result.spec.slot).toEqual({ removeOriginal: true });
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: '', indices: null, filterArgs: null },
      ]);
    });

    it("carries the keep-original toggle as the trailing false", () => {
      let l: SceneObject;
      sketch("xy", () => {
        l = aLine(45, 60) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(l!)[0])], 'slot', 10,
        { slot: { removeOriginal: false } },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('slot(l, 10, false)');
      expect(result.spec.slot).toEqual({ removeOriginal: false });
    });

    it("refuses picks spanning two geometries", () => {
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = hLine(60) as unknown as SceneObject;
        move([100, 0]);
        c = circle(20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(edgesOf(l!)[0]), refFor(edgesOf(c!)[0])],
        'slot',
        10,
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/one source geometry/) });
    });

    it("refuses an unbindable source honestly", () => {
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

      expect(synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c1!)[0])], 'slot', 10,
      )).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/call site produces multiple statements/),
      });
    });
  });

  describe("tArc to intersection (owner-level target)", () => {
    it("renders the picked edge's owner as the bare target variable", () => {
      let l: SceneObject;
      sketch("xy", () => {
        l = hLine(60) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(l!)[0])], 'tarc', 12,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('l');
      expect(result.preview).toBe('tArc(12, l)');
      expect(result.spec.feature).toBe('tarc');
      expect(result.spec.value).toBe(12);
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: '', indices: null, filterArgs: null },
      ]);
    });

    it("keeps the signed radius (negative flips the sweep)", () => {
      let c: SceneObject;
      sketch("xy", () => {
        move([100, 0]);
        c = circle(20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(c!, 4);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c!)[0])], 'tarc', -12,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('tArc(-12, c)');
      expect(result.spec.value).toBe(-12);
    });

    it("accepts a guide edge as the target", () => {
      let g: SceneObject;
      sketch("xy", () => {
        hLine(60);
        move([0, 40]);
        g = line([120, 40]).guide() as unknown as SceneObject;
      });
      const scene = render();
      setLocation(g!, 5);

      const guideEdge = g!.getShapes({ excludeGuide: false })
        .find((s): s is Edge => s instanceof Edge);
      expect(guideEdge).toBeDefined();

      const result = synthesizeSketchApplyFeature(
        scene, [{ shapeId: guideEdge!.id }], 'tarc', 15,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('l');
      expect(result.preview).toBe('tArc(15, l)');
      expect(result.spec.producers).toEqual([
        { line: 5, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ]);
    });

    it("refuses a multi-edge target honestly", () => {
      let r: Rect;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
      });
      const scene = render();
      setLocation(r!, 3);

      expect(synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'tarc', 12,
      )).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/single-edge geometry/),
      });
    });

    it("refuses picks spanning two geometries", () => {
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = hLine(60) as unknown as SceneObject;
        move([100, 0]);
        c = circle(20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(edgesOf(l!)[0]), refFor(edgesOf(c!)[0])],
        'tarc',
        12,
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/one target geometry/) });
    });

    it("refuses an unbindable target honestly", () => {
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

      expect(synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c1!)[0])], 'tarc', 12,
      )).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/call site produces multiple statements/),
      });
    });
  });

  describe("aLine to intersection (owner-level target)", () => {
    it("renders the picked edge's owner as the bare target variable", () => {
      let l: SceneObject;
      sketch("xy", () => {
        move([0, 40]);
        l = line([120, 40]) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 4);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(l!)[0])], 'aline', 30,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('l');
      expect(result.preview).toBe('aLine(30, l)');
      expect(result.spec.feature).toBe('aline');
      expect(result.spec.value).toBe(30);
      expect(result.spec.producers).toEqual([
        { line: 4, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: '', indices: null, filterArgs: null },
      ]);
    });

    it("accepts a multi-edge owner — the kernel intersects every edge", () => {
      let r: Rect;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
      });
      const scene = render();
      setLocation(r!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'aline', 45,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('r');
      expect(result.preview).toBe('aLine(45, r)');
    });

    it("accepts a guide edge as the target", () => {
      let g: SceneObject;
      sketch("xy", () => {
        hLine(60);
        move([0, 40]);
        g = line([120, 40]).guide() as unknown as SceneObject;
      });
      const scene = render();
      setLocation(g!, 5);

      const guideEdge = g!.getShapes({ excludeGuide: false })
        .find((s): s is Edge => s instanceof Edge);
      expect(guideEdge).toBeDefined();

      const result = synthesizeSketchApplyFeature(
        scene, [{ shapeId: guideEdge!.id }], 'aline', 30,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.preview).toBe('aLine(30, l)');
    });

    it("refuses picks spanning two geometries", () => {
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = hLine(60) as unknown as SceneObject;
        move([100, 0]);
        c = circle(20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(edgesOf(l!)[0]), refFor(edgesOf(c!)[0])],
        'aline',
        30,
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/one target geometry/) });
    });

    it("refuses an unbindable target honestly", () => {
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

      expect(synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c1!)[0])], 'aline', 30,
      )).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/call site produces multiple statements/),
      });
    });
  });

  describe("text path (owner-level, multi-edge owners allowed)", () => {
    it("renders the picked edge's owner as the bare path variable", () => {
      let c: SceneObject;
      sketch("xy", () => {
        c = circle(40) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(c!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c!)[0])], 'text',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('c');
      expect(result.spec.feature).toBe('text');
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: '', indices: null, filterArgs: null },
      ]);
    });

    it("accepts a multi-edge owner whose edges form one connected run", () => {
      let r: Rect;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
      });
      const scene = render();
      setLocation(r!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'text',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('r');
    });

    it("refuses picks spanning two geometries", () => {
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = hLine(60) as unknown as SceneObject;
        move([100, 0]);
        c = circle(20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      expect(synthesizeSketchApplyFeature(
        scene,
        [refFor(edgesOf(l!)[0]), refFor(edgesOf(c!)[0])],
        'text',
      )).toMatchObject({ ok: false, reason: expect.stringMatching(/one path geometry/) });
    });
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

  // The 2D copy is owner-level like the booleans: targets are whole
  // geometries as bare variables; an edge-picked direction resolves its
  // single-line owner, referenced as `axis(<var>)` by the route.
  describe("2D copy operands", () => {
    it("resolves targets to bare-variable producers and reports copySlots", () => {
      let r: Rect;
      let c: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([100, 0]);
        c = circle(10) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(roleEdge(r!, 'top')), refFor(edgesOf(c!)[0])],
        'copy',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('r, c');
      expect(result.spec.feature).toBe('copy');
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
        { line: 5, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
      ]);
      expect(result.spec.parts).toEqual([]);
      expect(result.copySlots).toEqual({ targets: [0, 1], axisParts: [] });
    });

    it("resolves an axis pick to its single-line owner as a bare selector part", () => {
      let r: Rect;
      let l: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([0, 80]);
        l = aLine(30, 50) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(l!, 5);

      const result = synthesizeSketchApplyFeature(
        scene, edgesOf(r!).map(refFor), 'copy', undefined,
        { axisRefs: [refFor(edgesOf(l!)[0])] },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('r');
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
        { line: 5, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 1, accessor: '', indices: null, filterArgs: null },
      ]);
      expect(result.copySlots).toEqual({ targets: [0], axisParts: [0] });
    });

    it("accepts an axis-only resolution (an edit re-picking just the direction)", () => {
      let l: SceneObject;
      sketch("xy", () => {
        rect(80, 60);
        move([0, 80]);
        l = aLine(30, 50) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 5);

      const result = synthesizeSketchApplyFeature(
        scene, [], 'copy', undefined, { axisRefs: [refFor(edgesOf(l!)[0])] },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.copySlots).toEqual({ targets: [], axisParts: [0] });
    });

    it("refuses a multi-edge owner as a direction", () => {
      let r: Rect;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
      });
      const scene = render();
      setLocation(r!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'copy', undefined,
        { axisRefs: [refFor(roleEdge(r!, 'left'))] },
      );

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/single straight line/),
      });
    });

    it("refuses a curved edge as a direction", () => {
      let r: Rect;
      let c: SceneObject;
      sketch("xy", () => {
        r = rect(80, 60) as Rect;
        move([100, 0]);
        c = circle(10) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(r!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(roleEdge(r!, 'top'))], 'copy', undefined,
        { axisRefs: [refFor(edgesOf(c!)[0])] },
      );

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/single straight line/),
      });
    });
  });
});

// The inverse direction (offset edit seeding): the statement's parsed target
// arguments re-resolve onto the active sketch's edges — the paused scene has
// no offset object to read, so the argument forms are the source of truth.
describe("sketch statement target resolution", () => {
  setupOC();

  const edgesOf = (obj: SceneObject): Edge[] =>
    obj.getShapes().filter((s): s is Edge => s instanceof Edge);

  function scene() {
    let r: Rect;
    let c: SceneObject;
    sketch("xy", () => {
      r = rect(80, 60) as Rect;
      move([100, 0]);
      c = circle(10) as unknown as SceneObject;
    });
    const rendered = render();
    setLocation(r!, 3);
    setLocation(c!, 5);
    return { rendered, r: r!, c: c! };
  }

  it("resolves a role accessor to its edge", () => {
    const { rendered, r } = scene();
    const result = resolveSketchStatementTargets(rendered, [
      { kind: 'accessor', line: 3, args: ['top'] },
    ]);
    expect(result).toEqual({
      ok: true,
      shapeIds: [edgesOf(r).find(e => e.role === 'top')!.id],
    });
  });

  it("resolves a bare owner to all its edges and a filter to its kind", () => {
    const { rendered, r, c } = scene();
    const owner = resolveSketchStatementTargets(rendered, [{ kind: 'owner', line: 3 }]);
    expect(owner.ok).toBe(true);
    if (owner.ok) {
      expect(owner.shapeIds.sort()).toEqual(edgesOf(r).map(e => e.id).sort());
    }
    const filtered = resolveSketchStatementTargets(rendered, [
      { kind: 'filter', calls: [{ name: 'circle', dim: null }] },
    ]);
    expect(filtered).toEqual({ ok: true, shapeIds: [edgesOf(c)[0].id] });
  });

  it("refuses a line with no producing statement", () => {
    const { rendered } = scene();
    const result = resolveSketchStatementTargets(rendered, [{ kind: 'owner', line: 99 }]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('line 99') });
  });
});
