import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import { Part } from "../../features/part.js";
import { Scene } from "../../rendering/scene.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionRequest, ResolveSelectionResult, ResolvedSelectionMatch } from "../../selection/resolve-selection.js";

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

function resolveOk(scene: Scene, request: ResolveSelectionRequest): Extract<ResolveSelectionResult, { ok: true }> {
  const result = SelectionResolver.resolve(scene, request);
  expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
  return result as Extract<ResolveSelectionResult, { ok: true }>;
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
