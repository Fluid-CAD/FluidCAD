import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import fillet from "../../core/fillet.js";
import { rect, polygon, slot, circle, hLine, aLine, move } from "../../core/2d/index.js";
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
