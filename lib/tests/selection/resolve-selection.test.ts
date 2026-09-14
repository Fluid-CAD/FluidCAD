import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import { circle } from "../../core/2d/index.js";
import { Part } from "../../features/part.js";
import { Scene } from "../../rendering/scene.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionRequest, ResolveSelectionResult, ResolvedSelectionMatch } from "../../selection/resolve-selection.js";
import type { SynthesizeOptions } from "../../selection/types.js";
import { setLocation } from "./pick-helpers.js";

/**
 * Two parts in one file: a 40×40×10 base and a 10×10×30 pillar standing on
 * its own footprint at (15,15). Both have a face on z=0; only the base has
 * one on z=10.
 */
function makeTwoParts(): Scene {
  part("base", () => {
    sketch("xy", () => {
      testRect(40, 40);
    });
    extrude(10);
  });
  part("pillar", () => {
    sketch("xy", () => {
      testRect(10, 10, { at: [15, 15] });
    });
    extrude(30);
  });
  const scene = render();
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
  return scene;
}

function partNamed(scene: Scene, name: string): Part {
  const found = scene.getAllSceneObjects().find((o): o is Part => o instanceof Part && o.partName === name);
  expect(found).toBeDefined();
  return found!;
}

function extrudeIn(scene: Scene, partName: string): string {
  const part = partNamed(scene, partName);
  const found = scene.getAllSceneObjects().find(o => o.getType() === 'extrude' && scene.findEnclosingPart(o) === part);
  expect(found).toBeDefined();
  return found!.id;
}

function resolveOk(scene: Scene, request: ResolveSelectionRequest, synthesis?: SynthesizeOptions): Extract<ResolveSelectionResult, { ok: true }> {
  const result = SelectionResolver.resolve(scene, request, synthesis);
  expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
  return result as Extract<ResolveSelectionResult, { ok: true }>;
}

/**
 * One part built in steps: a 100×100×50 box (line 4), a Ø40 pocket 30 deep
 * cut into its top (line 8), then a 3 mm fillet on the pocket's rim edges
 * (line 9). Every producer carries a source location so synthesis can bind
 * it to a variable.
 */
function makeSteps(): { scene: Scene; extrudeIndex: number; cutIndex: number; filletIndex: number } {
  sketch("xy", () => {
    testRect(100, 100);
  });
  const e = extrude(50);
  setLocation(e, 4);
  sketch(e.endFaces(), () => {
    circle([50, 50], 40);
  });
  const c = cut(30);
  setLocation(c, 8);
  const f = fillet(3, c.startEdges());
  setLocation(f, 9);
  const scene = render();
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
  const objects = scene.getAllSceneObjects();
  const indexOf = (type: string) => {
    const index = objects.findIndex(o => o.getType() === type);
    expect(index, type).toBeGreaterThanOrEqual(0);
    return index;
  };
  return { scene, extrudeIndex: indexOf('extrude'), cutIndex: indexOf('cut'), filletIndex: indexOf('fillet') };
}

/** The synthesized block of an ok result, asserted ok. */
function synthesizedOf(result: Extract<ResolveSelectionResult, { ok: true }>) {
  expect(result.synthesized).toBeDefined();
  const synthesized = result.synthesized!;
  expect(synthesized.ok, synthesized.ok === false ? synthesized.reason : '').toBe(true);
  return synthesized as Extract<typeof synthesized, { ok: true }>;
}

function resolveFail(scene: Scene, request: ResolveSelectionRequest): Extract<ResolveSelectionResult, { ok: false }> {
  const result = SelectionResolver.resolve(scene, request);
  expect(result.ok).toBe(false);
  return result as Extract<ResolveSelectionResult, { ok: false }>;
}

describe("SelectionResolver — part scoping", () => {
  setupOC();

  it("a filter scoped to one part never matches the other part's faces", () => {
    const scene = makeTwoParts();
    const onBase = resolveOk(scene, { expression: 'face().onPlane("xy", 0)', scope: { part: "base" } });
    expect(onBase.count).toBe(1);
    expect(onBase.matches[0].part).toBe("base");
    expect(onBase.scope).toEqual({ kind: 'part', partId: partNamed(scene, "base").id, part: "base" });

    const onPillar = resolveOk(scene, { expression: 'face().onPlane("xy", 0)', scope: { part: "pillar" } });
    expect(onPillar.count).toBe(1);
    expect(onPillar.matches[0].part).toBe("pillar");

    // The base's top face at z=10 does not exist on the pillar.
    const top = resolveOk(scene, { expression: 'face().onPlane("xy", 10)', scope: { part: "pillar" } });
    expect(top.count).toBe(0);
    expect(top.matches).toEqual([]);
  });

  it("a scene object id scopes to that object's enclosing part", () => {
    const scene = makeTwoParts();
    const pillarExtrude = extrudeIn(scene, "pillar");
    const result = resolveOk(scene, { expression: 'face().onPlane("xy", 0)', scope: { sceneObjectId: pillarExtrude } });
    expect(result.count).toBe(1);
    expect(result.matches[0].part).toBe("pillar");
    expect(result.scope).toMatchObject({ kind: 'sceneObject', sceneObjectId: pillarExtrude, part: "pillar" });
  });

  it("root scope matches both parts and names the owner of each match", () => {
    const scene = makeTwoParts();
    const result = resolveOk(scene, { expression: 'face().onPlane("xy", 0)' });
    expect(result.count).toBe(2);
    expect(result.scope).toEqual({ kind: 'root' });
    expect(result.matches.map(m => m.part).sort()).toEqual(["base", "pillar"]);
    for (const match of result.matches) {
      expect(match.sceneObjectId).toBe(extrudeIn(scene, match.part!));
    }
  });

  it(".from() crosses the part scope as it does in source", () => {
    const scene = makeTwoParts();
    const baseExtrude = extrudeIn(scene, "base");
    const result = resolveOk(scene, {
      expression: `face().onPlane("xy", 10).from($obj["${baseExtrude}"])`,
      scope: { part: "pillar" },
    });
    expect(result.count).toBe(1);
    expect(result.matches[0].part).toBe("base");
    expect(result.matches[0].sceneObjectId).toBe(baseExtrude);
  });

  it("a lazy accessor on a bound object resolves to that object's faces", () => {
    const scene = makeTwoParts();
    const baseExtrude = extrudeIn(scene, "base");
    const result = resolveOk(scene, { expression: `$obj["${baseExtrude}"].endFaces()` });
    expect(result.count).toBe(1);
    expect(result.matches[0].summary.center).toEqual([20, 20, 10]);
  });

  it("zero matches is a normal result", () => {
    const scene = makeTwoParts();
    const result = resolveOk(scene, { expression: 'edge().circle(5)' });
    expect(result.count).toBe(0);
    expect(result.unit).toBe('mm');
  });

  it("edge filters see the scoped faces they belong to", () => {
    const scene = makeTwoParts();
    const result = resolveOk(scene, { expression: 'edge().belongsToFace(face().onPlane("xy", 10))', scope: { part: "base" } });
    expect(result.count).toBe(4);
    for (const match of result.matches) {
      expect(match.kind).toBe('edge');
      expect(match.summary.form).toBe('line');
      expect(match.summary.length).toBe(40);
    }
  });

  it("carries a compact rounded summary per match", () => {
    const scene = makeTwoParts();
    const result = resolveOk(scene, { expression: 'face().onPlane("xy", 10)' });
    const match = result.matches[0];
    expect(match.kind).toBe('face');
    expect(match.summary.form).toBe('plane');
    expect(match.summary.center).toEqual([20, 20, 10]);
    expect(match.summary.area).toBe(1600);
    expect(Math.abs(match.summary.normal![2])).toBe(1);
    expect(match.summary.axis).toBeUndefined();
    expect(match.summary.diameter).toBeUndefined();
  });

  it("prices one match entry under the payload budget with a pinned field set", () => {
    const scene = makeTwoParts();
    const result = resolveOk(scene, { expression: 'face().onPlane("xy", 10)' });
    const match: ResolvedSelectionMatch = result.matches[0];
    // Every field earns its place: shapeId/kind/index address the entity for
    // measure and hit_test, sceneObjectId is the `$obj` key and the source
    // statement, sceneObjectName/part say what owns it, summary describes
    // it. Dropped on purpose: partId (the part name is the scope key and an
    // ambiguous name is refused with ids), raw MeasureVec objects (arrays
    // are a third shorter), unrounded coordinates. Anything else appearing
    // here is a payload regression.
    expect(Object.keys(match).sort()).toEqual([
      'index', 'kind', 'part', 'sceneObjectId', 'sceneObjectName', 'shapeId', 'summary',
    ]);
    expect(Object.keys(match.summary).sort()).toEqual(['area', 'center', 'form', 'normal']);
    const serialized = JSON.stringify(match);
    expect(serialized).not.toMatch(/\d\.\d{7,}/);
    // Two 36-character UUIDs (shape + scene object) are 100 bytes of
    // unavoidable addressing; everything else fits in the remaining budget.
    expect(serialized.length, serialized).toBeLessThan(250);
  });
});

describe("SelectionResolver — statement boundary", () => {
  setupOC();

  it("sees only the objects strictly before the boundary, like the statement's own arguments", () => {
    const { scene, extrudeIndex, cutIndex } = makeSteps();
    // Before the cut, the top of the box is one whole 100×100 face.
    const before = resolveOk(scene, { expression: 'face().onPlane("xy", 50)', before: cutIndex });
    expect(before.count).toBe(1);
    expect(before.before).toBe(cutIndex);
    expect(before.matches[0].summary.area).toBe(10000);
    expect(before.matches[0].sceneObjectId).toBe(scene.getAllSceneObjects()[extrudeIndex].id);
    // At the tip, the pocket has taken the disc out of it.
    const tip = resolveOk(scene, { expression: 'face().onPlane("xy", 50)' });
    expect(tip.count).toBe(1);
    expect(tip.matches[0].summary.area).toBeLessThan(10000);
    expect(tip.before).toBeUndefined();
  });

  it("addresses matches on the solids that exist at the boundary", () => {
    const { scene, cutIndex, filletIndex } = makeSteps();
    const beforeCut = resolveOk(scene, { expression: 'face().onPlane("xy", 50)', before: cutIndex });
    const beforeFillet = resolveOk(scene, { expression: 'face().onPlane("xy", 50)', before: filletIndex });
    // Different worlds, different solids: the box, then the pocketed box.
    expect(beforeCut.matches[0].shapeId).not.toBe(beforeFillet.matches[0].shapeId);
    expect(beforeFillet.matches[0].sceneObjectName).toBe(scene.getAllSceneObjects()[cutIndex].getName());
  });

  it("$obj binds only objects before the boundary and names the reason", () => {
    const { scene, cutIndex } = makeSteps();
    const cutId = scene.getAllSceneObjects()[cutIndex].id;
    const result = resolveFail(scene, { expression: `$obj["${cutId}"].startEdges()`, before: cutIndex });
    expect(result.code).toBe('evaluation-error');
    expect(result.reason).toContain(cutId);
    expect(result.reason).toContain(`before statement index ${cutIndex}`);
    // The same accessor resolves once the cut is inside the world.
    const after = resolveOk(scene, { expression: `$obj["${cutId}"].startEdges()`, before: cutIndex + 1 });
    expect(after.count).toBe(1);
    expect(after.matches[0].summary.form).toBe('circle');
  });

  it("refuses an out-of-range boundary with the valid range", () => {
    const { scene } = makeSteps();
    const total = scene.getAllSceneObjects().length;
    for (const before of [0, -1, total + 1, 1.5]) {
      const result = resolveFail(scene, { expression: 'face()', before });
      expect(result.code).toBe('invalid-boundary');
      expect(result.reason).toContain(`1 to ${total}`);
    }
    // The last valid boundary is the whole scene.
    expect(resolveOk(scene, { expression: 'face().onPlane("xy", 50)', before: total }).count).toBe(1);
  });

  it("refuses a part scope whose part begins at or after the boundary, and an instance scope with any boundary", () => {
    const scene = makeTwoParts();
    const pillar = partNamed(scene, "pillar");
    const pillarIndex = scene.getAllSceneObjects().indexOf(pillar);
    const result = resolveFail(scene, { expression: 'face()', scope: { part: "pillar" }, before: pillarIndex });
    expect(result.code).toBe('invalid-boundary');
    expect(result.reason).toContain('"pillar"');
    const base = resolveOk(scene, { expression: 'face().onPlane("xy", 0)', scope: { part: "base" }, before: pillarIndex });
    expect(base.count).toBe(1);

    const instance = resolveFail(scene, { expression: 'face()', scope: { instanceId: 'anything' }, before: 1 });
    expect(instance.code).toBe('invalid-boundary');
    expect(instance.reason).toContain('instance scope');
  });
});

describe("SelectionResolver — picks", () => {
  setupOC();

  it("resolves explicit picks to the same matches a filter gives", () => {
    const scene = makeTwoParts();
    const viaFilter = resolveOk(scene, { expression: 'face().onPlane("xy", 10)' });
    const top = viaFilter.matches[0];
    const viaPick = resolveOk(scene, { picks: [{ shapeId: top.shapeId, sub: { type: 'face', index: top.index } }] });
    expect(viaPick.count).toBe(1);
    expect(viaPick.matches[0]).toEqual(top);
    expect(viaPick.scope).toEqual({ kind: 'root' });
  });

  it("refuses a pick on an unknown solid, an out-of-range index, or outside the scope part", () => {
    const scene = makeTwoParts();
    const top = resolveOk(scene, { expression: 'face().onPlane("xy", 10)' }).matches[0];

    const unknown = resolveFail(scene, { picks: [{ shapeId: 'nope', sub: { type: 'face', index: 0 } }] });
    expect(unknown.code).toBe('unresolved-pick');
    expect(unknown.reason).toContain('"nope"');
    expect(unknown.pick).toEqual({ shapeId: 'nope', sub: { type: 'face', index: 0 } });

    const outOfRange = resolveFail(scene, { picks: [{ shapeId: top.shapeId, sub: { type: 'face', index: 99 } }] });
    expect(outOfRange.code).toBe('unresolved-pick');
    expect(outOfRange.reason).toContain('has 6 faces');

    const wrongPart = resolveFail(scene, { picks: [{ shapeId: top.shapeId, sub: { type: 'face', index: top.index } }], scope: { part: "pillar" } });
    expect(wrongPart.code).toBe('out-of-scope');
    expect(wrongPart.reason).toContain('part "base"');
    expect(wrongPart.reason).toContain('part "pillar"');
  });

  it("a pick at a boundary must exist in that world", () => {
    const { scene, cutIndex } = makeSteps();
    const tipTop = resolveOk(scene, { expression: 'face().onPlane("xy", 50)' }).matches[0];
    const result = resolveFail(scene, { picks: [{ shapeId: tipTop.shapeId, sub: { type: 'face', index: tipTop.index } }], before: cutIndex });
    expect(result.code).toBe('unresolved-pick');
    expect(result.reason).toContain(`rollback_to(${cutIndex - 1})`);
  });

  it("requires exactly one of expression and picks", () => {
    const scene = makeTwoParts();
    expect(resolveFail(scene, {}).code).toBe('invalid-request');
    expect(resolveFail(scene, { expression: 'face()', picks: [] }).code).toBe('invalid-request');
    expect(resolveFail(scene, { picks: [] }).code).toBe('invalid-request');
  });
});

describe("SelectionResolver — mixed selections", () => {
  setupOC();

  it("an array may mix filters and accessors, as a feature's argument list does", () => {
    const scene = makeTwoParts();
    const baseExtrude = extrudeIn(scene, "base");
    const result = resolveOk(scene, {
      expression: `[$obj["${baseExtrude}"].endFaces(), face().onPlane("xy", 0)]`,
      scope: { part: "pillar" },
    });
    // The accessor crosses the scope (as .from() does); the filter stays in it.
    expect(result.count).toBe(2);
    expect(result.matches.map(m => m.part).sort()).toEqual(["base", "pillar"]);
  });
});

describe("SelectionResolver — synthesis", () => {
  setupOC();

  it("answers a baked-constant filter with the feature accessor that names the same faces", () => {
    const { scene } = makeSteps();
    const result = resolveOk(scene, { expression: 'face().onPlane("xy", 0)' }, {});
    expect(result.count).toBe(1);
    const synthesized = synthesizedOf(result);
    expect(synthesized.source).toBe('e.startFaces()');
    expect(synthesized.expression).toBe(`$obj["${synthesized.producers[0].sceneObjectId}"].startFaces()`);
    expect(synthesized.sameAsInput).toBe(false);
    expect(synthesized.parts).toEqual([{ producer: synthesized.producers[0].sceneObjectId, accessor: 'startFaces', tier: 0 }]);
    expect(synthesized.producers[0]).toMatchObject({ featureType: 'extrude', variable: 'e', line: 4, filePath: '/ws/model.fluid.js' });
    expect(synthesized.imports).toEqual([]);
  });

  it("reports the input unchanged when it already is the winning form, whitespace and quotes aside", () => {
    const { scene } = makeSteps();
    const first = resolveOk(scene, { expression: 'face().onPlane("xy", 0)' }, {});
    const winner = synthesizedOf(first).expression;
    const again = resolveOk(scene, { expression: winner.replace(/"/g, "'").replace('(', '( ') }, {});
    const synthesized = synthesizedOf(again);
    expect(synthesized.sameAsInput).toBe(true);
    expect(synthesized.expression).toBe(winner);
  });

  it("synthesizes from picks, so a hit_test result becomes a selector", () => {
    const { scene } = makeSteps();
    // At the tip, two Ø40 circles survive: the pocket floor's rim (the cut's
    // end edges) and the fillet's lower tangent edge, which no bucket names.
    const rims = resolveOk(scene, { expression: 'edge().circle(40)' });
    expect(rims.count).toBe(2);
    const picks = rims.matches.map(m => ({ shapeId: m.shapeId, sub: { type: m.kind, index: m.index } }));
    const result = resolveOk(scene, { picks }, {});
    const synthesized = synthesizedOf(result);
    expect(synthesized.source).toContain('c.endEdges()');
    expect(synthesized.source).toContain('select(edge()');
    expect(synthesized.parts.map(p => p.tier).sort()).toEqual([0, 3]);
    expect(synthesized.imports).toContain('select');
    // The evaluable form lists both parts; it resolves back to the same two edges.
    expect(synthesized.expression.startsWith('[')).toBe(true);
    const roundTrip = resolveOk(scene, { expression: synthesized.expression });
    expect(roundTrip.matches.map(m => `${m.shapeId}/${m.index}`).sort()).toEqual(rims.matches.map(m => `${m.shapeId}/${m.index}`).sort());
  });

  it("synthesizes at the boundary against the world the statement sees, binding only producers before it", () => {
    const { scene, filletIndex } = makeSteps();
    // The fillet's own argument: the pocket's top rim, which only exists before the fillet runs.
    const result = resolveOk(scene, { expression: 'edge().circle(40).onPlane("xy", 50)', before: filletIndex }, {});
    expect(result.count).toBe(1);
    const synthesized = synthesizedOf(result);
    expect(synthesized.source).toBe('c.startEdges()');
    expect(synthesized.producers[0]).toMatchObject({ featureType: 'cut', variable: 'c', line: 8 });
    expect(synthesized.sameAsInput).toBe(false);
  });

  it("uses the namer's variable names and the bindable probe from the file", () => {
    const { scene } = makeSteps();
    const result = resolveOk(scene, { expression: 'face().onPlane("xy", 0)' }, {
      namer: producers => producers.map(p => (p.line === 4 ? 'box' : null)),
    });
    expect(synthesizedOf(result).source).toBe('box.startFaces()');

    const unbindable = resolveOk(scene, { expression: 'face().onPlane("xy", 0)' }, {
      bindable: producer => producer.line !== 4,
    });
    const synthesized = synthesizedOf(unbindable);
    expect(synthesized.source).toMatch(/^select\(face\(\)/);
    expect(synthesized.parts[0].tier).toBe(3);
    expect(synthesized.imports).toContain('select');
    // The tool form of a global select() is the bare filter — evaluable here.
    const roundTrip = resolveOk(scene, { expression: synthesized.expression });
    expect(roundTrip.count).toBe(1);
  });

  it("skips synthesis without options and on zero matches", () => {
    const { scene } = makeSteps();
    expect(resolveOk(scene, { expression: 'face().onPlane("xy", 0)' }).synthesized).toBeUndefined();
    expect(resolveOk(scene, { expression: 'edge().circle(5)' }, {}).synthesized).toBeUndefined();
  });
});

describe("SelectionResolver — refusals", () => {
  setupOC();

  it("refuses an unknown part or scene object scope by name", () => {
    const scene = makeTwoParts();
    const part = resolveFail(scene, { expression: 'face()', scope: { part: "nope" } });
    expect(part.code).toBe('unknown-scope');
    expect(part.reason).toContain('"nope"');
    const obj = resolveFail(scene, { expression: 'face()', scope: { sceneObjectId: "obj-none" } });
    expect(obj.code).toBe('unknown-scope');
    expect(obj.reason).toContain('"obj-none"');
    const inst = resolveFail(scene, { expression: 'face()', scope: { instanceId: "inst-0" } });
    expect(inst.code).toBe('unknown-scope');
    expect(inst.reason).toContain('assembly');
  });

  it("reports an expression that fails to evaluate, naming the problem", () => {
    const scene = makeTwoParts();
    const result = resolveFail(scene, { expression: 'face().onPlan("xy")' });
    expect(result.code).toBe('evaluation-error');
    expect(result.reason).toContain('onPlan');
  });

  it("refuses an expression that yields a feature instead of a selection, pointing at from()", () => {
    const scene = makeTwoParts();
    const baseExtrude = extrudeIn(scene, "base");
    const result = resolveFail(scene, { expression: `$obj["${baseExtrude}"]` });
    expect(result.code).toBe('evaluation-error');
    expect(result.reason).toContain('extrude');
    expect(result.reason).toContain(`face().from($obj["${baseExtrude}"])`);
    const plain = resolveFail(scene, { expression: '42' });
    expect(plain.code).toBe('evaluation-error');
    expect(plain.reason).toContain('number');
  });

  it("binds only face, edge and $obj — host globals are out of scope", () => {
    const scene = makeTwoParts();
    const result = resolveFail(scene, { expression: 'process.exit' });
    expect(result.code).toBe('evaluation-error');
  });
});

describe("SelectionResolver — assembly instance scope", () => {
  setupOC();

  it("scopes to the instance's part build and poses the matches like measure", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("box", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
    });
    insert(def);
    insert(def).translate(30, 0, 0);
    render();
    expect(scene.getRenderedObjects().filter(r => r.hasError)).toEqual([]);
    const [first, second] = scene.getSerializedInstances().map(i => i.instanceId);

    const posed = resolveOk(scene, { expression: 'face().onPlane("xy", 10)', scope: { instanceId: second } });
    expect(posed.count).toBe(1);
    const match = posed.matches[0];
    expect(match.instanceId).toBe(second);
    expect(match.pose?.position).toEqual({ x: 30, y: 0, z: 0 });
    expect(match.part).toBe("box");
    expect(match.summary.center).toEqual([40, 10, 10]);
    expect(posed.scope).toMatchObject({ kind: 'instance', instanceId: second, part: "box" });

    const home = resolveOk(scene, { expression: 'face().onPlane("xy", 10)', scope: { instanceId: first } });
    expect(home.matches[0].summary.center).toEqual([10, 10, 10]);
    expect(home.matches[0].shapeId).toBe(match.shapeId);

    // The match feeds measure unchanged: the instances' top faces (x 0..20
    // and 30..50) are 10 apart at their nearest points, in world coordinates.
    const measured = getSceneManager().measure(scene, [home.matches[0], match]);
    expect(measured).not.toBeNull();
    expect(measured!.entities[1].ref.instanceId).toBe(second);
    expect(measured!.entities[1].summary.center).toEqual([40, 10, 10]);
    expect(measured!.minDist?.value).toBeCloseTo(10, 4);
  });

  it("refuses an unknown instance id", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("box", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
    });
    insert(def);
    render();
    const result = resolveFail(scene, { expression: 'face()', scope: { instanceId: "inst-99" } });
    expect(result.code).toBe('unknown-scope');
    expect(result.reason).toContain('"inst-99"');
  });
});
