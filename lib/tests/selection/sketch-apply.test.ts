import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import { circle, line } from "../../core/2d/index.js";
import { Edge } from "../../common/edge.js";
import { SceneObject } from "../../common/scene-object.js";
import { synthesizeSketchApplyFeature } from "../../selection/sketch-apply.js";
import { setLocation } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

// Stage 3 (plans/sketch-edge-selection): the 2D branch of the selection
// kernel — {shapeId} picks resolve through the sketch edge index and
// synthesize construction-relative selectors, verified generate-and-test.
describe("sketch apply-feature synthesis", () => {
  setupOC();

  const edgesOf = (obj: SceneObject): Edge[] =>
    obj.getShapes().filter((s): s is Edge => s instanceof Edge);

  const refFor = (edge: Edge) => ({ shapeId: edge.id });

  /** First real edge of a solved primitive, as a pick ref. */
  const solvedRef = (obj: unknown) => refFor(edgesOf(obj as SceneObject)[0]);

  it("falls back to an edge filter for shared call sites", () => {
    let h1: SceneObject;
    let h2: SceneObject;
    sketch("xy", () => {
      h1 = line([0, 0], [30, 0]) as unknown as SceneObject;
      h2 = line([0, 20], [40, 20]) as unknown as SceneObject;
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
      c1 = circle([0, 0], 40) as unknown as SceneObject;
      c2 = circle([100, 0], 20) as unknown as SceneObject;
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

  it("carries the offset close toggle into the statement it previews", () => {
    let r: ReturnType<typeof testRect>;
    sketch("xy", () => {
      r = testRect(80, 60);
    });
    const scene = render();
    setLocation(r!.b as unknown as SceneObject, 3);
    setLocation(r!.r as unknown as SceneObject, 4);
    setLocation(r!.t as unknown as SceneObject, 5);
    setLocation(r!.l as unknown as SceneObject, 6);

    const closed = synthesizeSketchApplyFeature(
      scene, [solvedRef(r!.t)], 'offset', 3,
      { offset: { close: true } },
    );
    expect(closed).toMatchObject({
      ok: true,
      preview: "offset(3, l).close()",
      spec: { offset: { close: true } },
    });

    // The toggle is offset's own — a fillet never grows the chain.
    const filleted = synthesizeSketchApplyFeature(
      scene, [solvedRef(r!.t), solvedRef(r!.l)], 'fillet', 3,
      { offset: { close: true } },
    );
    expect(filleted).toMatchObject({ ok: true, spec: { offset: undefined } });
    if (filleted.ok) {
      expect(filleted.preview).toBe(`fillet(3, ${filleted.args})`);
    }
  });

  it("hints instead of no-opping when fillet picks share no corner", () => {
    let r: ReturnType<typeof testRect>;
    sketch("xy", () => {
      r = testRect(80, 60);
    });
    const scene = render();
    setLocation(r!.b as unknown as SceneObject, 3);
    setLocation(r!.r as unknown as SceneObject, 4);
    setLocation(r!.t as unknown as SceneObject, 5);
    setLocation(r!.l as unknown as SceneObject, 6);

    // Opposite sides never touch — Fillet2D would silently do nothing.
    const opposite = synthesizeSketchApplyFeature(
      scene,
      [solvedRef(r!.t), solvedRef(r!.b)],
      'fillet',
      4,
    );
    expect(opposite).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/do not touch/),
    });

    // A single edge has no corner either.
    const single = synthesizeSketchApplyFeature(
      scene, [solvedRef(r!.t)], 'fillet', 4,
    );
    expect(single).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/single edge has no corner/),
    });

    // The same single-edge pick offsets fine — the hint is fillet-only.
    const offsetSingle = synthesizeSketchApplyFeature(
      scene, [solvedRef(r!.t)], 'offset', 2,
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
      // The 0.005 corner miss is deliberate — no coincident constraint.
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

  it("refuses picks spanning different sketches", () => {
    let r1: ReturnType<typeof testRect>;
    let r2: ReturnType<typeof testRect>;
    sketch("xy", () => {
      r1 = testRect(80, 60);
    });
    sketch("xz", () => {
      r2 = testRect(40, 30);
    });
    const scene = render();
    setLocation(r1!.t as unknown as SceneObject, 3);
    setLocation(r2!.t as unknown as SceneObject, 7);

    const result = synthesizeSketchApplyFeature(
      scene,
      [solvedRef(r1!.t), solvedRef(r2!.t)],
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
        testRect(80, 60);
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
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = line([0, 60], [80, 60]) as unknown as SceneObject;
        c = circle([100, 0], 10) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene,
        [refFor(edgesOf(l!)[0]), refFor(edgesOf(c!)[0])],
        'copy',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('l, c');
      expect(result.spec.feature).toBe('copy');
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'line', nameHint: 'l', bind: true },
        { line: 5, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
      ]);
      expect(result.spec.parts).toEqual([]);
      expect(result.copySlots).toEqual({ targets: [0, 1], axisParts: [] });
    });

    it("resolves an axis pick to its single-line owner as a bare selector part", () => {
      let c: SceneObject;
      let l: SceneObject;
      sketch("xy", () => {
        c = circle([40, 30], 20) as unknown as SceneObject;
        // Legacy fixture was aLine(30, 50) from [0, 80].
        l = line([0, 80], [50 * Math.cos(Math.PI / 6), 80 + 50 * Math.sin(Math.PI / 6)]) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(c!, 3);
      setLocation(l!, 5);

      const result = synthesizeSketchApplyFeature(
        scene, edgesOf(c!).map(refFor), 'copy', undefined,
        { axisRefs: [refFor(edgesOf(l!)[0])] },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('c');
      expect(result.spec.producers).toEqual([
        { line: 3, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
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
        testRect(80, 60);
        // Legacy fixture was aLine(30, 50) from [0, 80].
        l = line([0, 80], [50 * Math.cos(Math.PI / 6), 80 + 50 * Math.sin(Math.PI / 6)]) as unknown as SceneObject;
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

    it("refuses a curved edge as a direction", () => {
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = line([0, 60], [80, 60]) as unknown as SceneObject;
        c = circle([100, 0], 10) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(l!)[0])], 'copy', undefined,
        { axisRefs: [refFor(edgesOf(c!)[0])] },
      );

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/single straight line/),
      });
    });
  });

  describe("rotate2d center references", () => {
    it("resolves a picked line endpoint to a bound accessor center", () => {
      let l: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l = line([0, 60], [80, 60]) as unknown as SceneObject;
        c = circle([100, 0], 10) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(l!, 3);
      setLocation(c!, 5);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c!)[0])], 'rotate2d', 45,
        { rotate2d: { center: { line: 3, role: 'end', featureType: 'line' }, copy: false } },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.args).toBe('c');
      expect(result.centerExpr).toBe('l.end()');
      // The transform refuses a rotate spec without its nonzero angle — the
      // value must ride the spec, not just the route's preview render.
      expect(result.spec.value).toBe(45);
      expect(result.spec.producers).toEqual([
        { line: 5, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
        { line: 3, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ]);
      expect(result.spec.parts).toEqual([
        { producer: 0, accessor: '', indices: null, filterArgs: null },
      ]);
      expect(result.spec.rotate2d).toEqual({
        center: { producer: 1, accessor: 'end' },
        copy: false,
      });
      expect(result.preview).toBe('rotate(<angle>, l.end(), c)');
    });

    it("reuses the target's own producer when the center sits on it", () => {
      let c: SceneObject;
      sketch("xy", () => {
        c = circle([40, 30], 20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(c!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c!)[0])], 'rotate2d', 45,
        { rotate2d: { center: { line: 3, role: 'center', featureType: 'circle' }, copy: true } },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.centerExpr).toBe('c.center()');
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.rotate2d).toEqual({
        center: { producer: 0, accessor: 'center' },
        copy: true,
      });
      expect(result.preview).toBe('rotate(<angle>, c.center(), true, c)');
    });

    it("passes a literal center through untouched", () => {
      let c: SceneObject;
      sketch("xy", () => {
        c = circle([40, 30], 20) as unknown as SceneObject;
      });
      const scene = render();
      setLocation(c!, 3);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c!)[0])], 'rotate2d', 45,
        { rotate2d: { center: [10, 'h / 2'], copy: false } },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.centerExpr).toBe('[10, h / 2]');
      expect(result.spec.rotate2d).toEqual({ center: [10, 'h / 2'], copy: false });
    });

    it("refuses a center whose statement shares its call site", () => {
      let l1: SceneObject;
      let l2: SceneObject;
      let c: SceneObject;
      sketch("xy", () => {
        l1 = line([0, 0], [30, 0]) as unknown as SceneObject;
        l2 = line([0, 20], [40, 20]) as unknown as SceneObject;
        c = circle([100, 0], 10) as unknown as SceneObject;
      });
      const scene = render();
      // Same call site: a loop or helper executed the statement twice.
      setLocation(l1!, 4);
      setLocation(l2!, 4);
      setLocation(c!, 7);

      const result = synthesizeSketchApplyFeature(
        scene, [refFor(edgesOf(c!)[0])], 'rotate2d', 45,
        { rotate2d: { center: { line: 4, role: 'end', featureType: 'line' }, copy: false } },
      );

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/does not resolve to one sketch primitive/),
      });
    });
  });
});
