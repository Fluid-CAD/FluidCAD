import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import plane from "../../core/plane.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { SceneInterference } from "../../validation/scene-interference.js";
import type { InterferenceRequest, SceneInterferenceOutcome, SceneInterferenceReport } from "../../validation/scene-interference.js";

function assertClean(scene: Scene): void {
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
}

function checkReport(scene: Scene, request?: InterferenceRequest): SceneInterferenceReport {
  const outcome = SceneInterference.check(scene, request);
  expect(outcome.kind, outcome.kind === 'refused' ? outcome.reason : '').toBe('report');
  return (outcome as Extract<SceneInterferenceOutcome, { kind: 'report' }>).report;
}

function checkRefusal(scene: Scene, request: InterferenceRequest): Extract<SceneInterferenceOutcome, { kind: 'refused' }> {
  const outcome = SceneInterference.check(scene, request);
  expect(outcome.kind).toBe('refused');
  return outcome as Extract<SceneInterferenceOutcome, { kind: 'refused' }>;
}

/** Two 20×20×10 boxes at the root, the second offset by (10, 10) so they share 10×10×10. */
function makeOverlappingRootBoxes(): Scene {
  sketch("xy", () => {
    testRect(20, 20);
  });
  extrude(10);
  sketch("xy", () => {
    testRect(20, 20, { at: [10, 10] });
  });
  extrude(10).new();
  const scene = render();
  assertClean(scene);
  return scene;
}

/** A 40×40×10 base and a 10×10×30 pillar, each its own part; `pillarZ` lifts the pillar's sketch plane. */
function makeTwoParts(pillarZ: number, pillarAt: [number, number] = [15, 15]): Scene {
  part("base", () => {
    sketch("xy", () => {
      testRect(40, 40);
    });
    extrude(10);
  });
  part("pillar", () => {
    sketch(pillarZ === 0 ? "xy" : plane("xy", pillarZ), () => {
      testRect(10, 10, { at: pillarAt });
    });
    extrude(30);
  });
  const scene = render();
  assertClean(scene);
  return scene;
}

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };

describe("SceneInterference — part files", () => {
  setupOC();

  it("two overlapping solids in a file without parts are a clash between two units", () => {
    const scene = makeOverlappingRootBoxes();
    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toBeUndefined();
    expect(report.bodies).toBe(2);
    expect(report.units).toBe(2);
    expect(report.checked).toBe(1);
    expect(report.rejectedByBounds).toBe(0);
    expect(report.intraPart).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.clashes).toHaveLength(1);
    const clash = report.clashes[0];
    expect(clash.volume).toBe(1000);
    expect(clash.a.part).toBeNull();
    expect(clash.b.part).toBeNull();
    expect(clash.a.instanceId).toBeUndefined();
    expect(clash.a.shapeId).not.toBe(clash.b.shapeId);
    expect(clash.a.sceneObjectId).not.toBe(clash.b.sceneObjectId);
    expect(report.unit).toBe('mm');
    expect(report.tolerance).toBe(1);
  });

  it("the same two solids inside one part are intraPart, and one part alone is inconclusive rather than a pass", () => {
    part("block", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
      sketch("xy", () => {
        testRect(20, 20, { at: [10, 10] });
      });
      extrude(10).new();
    });
    const scene = render();
    assertClean(scene);

    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toContain('one part');
    expect(report.units).toBe(1);
    expect(report.clashes).toEqual([]);
    expect(report.intraPart).toHaveLength(1);
    expect(report.intraPart[0].volume).toBe(1000);
    expect(report.intraPart[0].a.part).toBe('block');
  });

  it("an intraPart overlap next to a clear second part is ok", () => {
    part("block", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
      sketch("xy", () => {
        testRect(20, 20, { at: [10, 10] });
      });
      extrude(10).new();
    });
    part("far", () => {
      sketch("xy", () => {
        testRect(10, 10, { at: [100, 100] });
      });
      extrude(10);
    });
    const scene = render();
    assertClean(scene);

    const report = checkReport(scene);
    expect(report.ok).toBe(true);
    expect(report.inconclusive).toBeUndefined();
    expect(report.bodies).toBe(3);
    expect(report.units).toBe(2);
    expect(report.clashes).toEqual([]);
    expect(report.intraPart).toHaveLength(1);
    expect(report.intraPart[0].a.part).toBe('block');
    expect(report.intraPart[0].b.part).toBe('block');
    // The far part's bounds never meet the block's two bodies; only the intra pair ran.
    expect(report.checked).toBe(1);
    expect(report.rejectedByBounds).toBe(2);
  });

  it("two parts overlapping are a clash naming both parts", () => {
    const scene = makeTwoParts(0);
    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.clashes).toHaveLength(1);
    expect([report.clashes[0].a.part, report.clashes[0].b.part].sort()).toEqual(['base', 'pillar']);
    expect(report.clashes[0].volume).toBe(1000);
    expect(report.checked).toBe(1);
  });

  it("two parts that touch on a face share no volume and pass, and the pair was checked, not bounds-rejected", () => {
    const scene = makeTwoParts(10);
    const report = checkReport(scene);
    expect(report.ok).toBe(true);
    expect(report.inconclusive).toBeUndefined();
    expect(report.clashes).toEqual([]);
    expect(report.checked).toBe(1);
    expect(report.rejectedByBounds).toBe(0);
    expect(report.failed).toEqual([]);
  });

  it("a pair whose bounds do not meet is counted as rejected and never reaches the boolean", () => {
    const scene = makeTwoParts(50);
    const report = checkReport(scene);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
    expect(report.rejectedByBounds).toBe(1);
  });

  it("a single body is inconclusive with ok false", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    extrude(10);
    const scene = render();
    assertClean(scene);
    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toContain('only one');
    expect(report.bodies).toBe(1);
    expect(report.checked).toBe(0);
    expect(report.clashes).toEqual([]);
  });

  it("no solid at all is inconclusive, and a named sketch shape is refused as not a solid", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const scene = render();
    assertClean(scene);
    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toContain('no rendered solid');

    const rendered = scene.getRenderedObjects().find(r => r.visible && r.sceneShapes.length > 0 && !r.isContainer);
    expect(rendered).toBeDefined();
    const refusal = checkRefusal(scene, { shapeIds: [rendered!.sceneShapes[0].shapeId] });
    expect(refusal.code).toBe('unknown-shape');
    expect(refusal.reason).toContain('not a solid');
  });

  it("tolerance raises the bar: an overlap below it is not a clash", () => {
    const scene = makeTwoParts(0);
    const below = checkReport(scene, { tolerance: 1001 });
    expect(below.ok).toBe(true);
    expect(below.clashes).toEqual([]);
    expect(below.checked).toBe(1);
    expect(below.tolerance).toBe(1001);
    const above = checkReport(scene, { tolerance: 999 });
    expect(above.ok).toBe(false);
    expect(above.clashes).toHaveLength(1);
  });

  it("shapeIds narrows the bodies, an unknown id is refused, and instanceIds or poses need an assembly", () => {
    const scene = makeTwoParts(0);
    const all = checkReport(scene);
    const baseShape = all.clashes[0].a.part === 'base' ? all.clashes[0].a.shapeId : all.clashes[0].b.shapeId;

    const one = checkReport(scene, { shapeIds: [baseShape] });
    expect(one.bodies).toBe(1);
    expect(one.ok).toBe(false);
    expect(one.inconclusive).toContain('only one');

    const missing = checkRefusal(scene, { shapeIds: [baseShape, 'nope'] });
    expect(missing.code).toBe('unknown-shape');
    expect(missing.reason).toContain('"nope"');

    expect(checkRefusal(scene, { instanceIds: ['inst-1'] }).code).toBe('not-an-assembly');
    expect(checkRefusal(scene, { poses: [{ instanceId: 'inst-1', position: { x: 0, y: 0, z: 0 }, quaternion: IDENTITY_Q }] }).code).toBe('not-an-assembly');
  });
});

describe("SceneInterference — assemblies", () => {
  setupOC();

  function boxDef() {
    return part("box", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
    });
  }

  it("two instances of one part placed to overlap clash, listing both instance ids; moved apart they pass", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = boxDef();
    insert(def);
    insert(def).translate(10, 0, 0);
    render();
    assertClean(scene);
    const ids = scene.getSerializedInstances().map(i => i.instanceId);
    expect(ids).toHaveLength(2);

    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toBeUndefined();
    expect(report.bodies).toBe(2);
    expect(report.units).toBe(2);
    expect(report.checked).toBe(1);
    expect(report.clashes).toHaveLength(1);
    const clash = report.clashes[0];
    expect(clash.volume).toBe(2000);
    expect([clash.a.instanceId, clash.b.instanceId].sort()).toEqual([...ids].sort());
    // Both bodies are the same prototype shape: the instance id is what tells them apart.
    expect(clash.a.shapeId).toBe(clash.b.shapeId);
    expect(clash.a.part).toBe('box');
    expect(clash.b.part).toBe('box');
    expect(report.intraPart).toEqual([]);

    // The same pair, moved apart through a live pose, is clear.
    const posed = checkReport(scene, { poses: [{ instanceId: ids[1], position: { x: 40, y: 0, z: 0 }, quaternion: IDENTITY_Q }] });
    expect(posed.ok).toBe(true);
    expect(posed.clashes).toEqual([]);
    expect(posed.rejectedByBounds).toBe(1);
    expect(posed.checked).toBe(0);
  });

  it("instances moved apart in the source pass, with the pair bounds-rejected", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = boxDef();
    insert(def);
    insert(def).translate(40, 0, 0);
    render();
    assertClean(scene);

    const report = checkReport(scene);
    expect(report.ok).toBe(true);
    expect(report.bodies).toBe(2);
    expect(report.clashes).toEqual([]);
    expect(report.rejectedByBounds).toBe(1);
    expect(report.checked).toBe(0);
  });

  it("a rotated instance is placed by its full statement pose", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = boxDef();
    insert(def);
    // A quarter turn about Z swings the box to x ∈ [-20, 0]; moved to x = 10 it covers half of the first.
    // (rotate() turns the whole pose about the world axis, so it goes before translate().)
    insert(def).rotate("z", 90).translate(10, 0, 0);
    render();
    assertClean(scene);

    const report = checkReport(scene);
    expect(report.clashes).toHaveLength(1);
    expect(report.clashes[0].volume).toBe(2000);
  });

  it("instanceIds: one id tests that instance against everything, two ids test only that pair, unknown is refused", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = boxDef();
    insert(def).name("a");
    insert(def).translate(10, 0, 0).name("b");
    insert(def).translate(100, 0, 0).name("c");
    insert(def).translate(110, 0, 0).name("d");
    render();
    assertClean(scene);
    const byName = new Map(scene.getSerializedInstances().map(i => [i.name, i.instanceId]));

    const all = checkReport(scene);
    expect(all.clashes).toHaveLength(2);
    expect(all.checked).toBe(2);
    expect(all.rejectedByBounds).toBe(4);

    const onlyA = checkReport(scene, { instanceIds: [byName.get('a')!] });
    expect(onlyA.bodies).toBe(4);
    expect(onlyA.clashes).toHaveLength(1);
    expect(onlyA.checked).toBe(1);
    expect(onlyA.rejectedByBounds).toBe(2);
    expect([onlyA.clashes[0].a.instanceId, onlyA.clashes[0].b.instanceId]).toContain(byName.get('a'));

    const aAndC = checkReport(scene, { instanceIds: [byName.get('a')!, byName.get('c')!] });
    expect(aAndC.ok).toBe(true);
    expect(aAndC.bodies).toBe(2);
    expect(aAndC.clashes).toEqual([]);
    expect(aAndC.checked).toBe(0);
    expect(aAndC.rejectedByBounds).toBe(1);

    const cAndD = checkReport(scene, { instanceIds: [byName.get('c')!, byName.get('d')!] });
    expect(cAndD.ok).toBe(false);
    expect(cAndD.clashes).toHaveLength(1);

    expect(checkRefusal(scene, { instanceIds: [byName.get('a')!, 'nope'] }).code).toBe('unknown-instance');
    expect(checkRefusal(scene, { poses: [{ instanceId: 'nope', position: { x: 0, y: 0, z: 0 }, quaternion: IDENTITY_Q }] }).code).toBe('unknown-instance');
  });

  it("a multi-solid part's internal overlap is intraPart per instance and never a clash", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("pair", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
      sketch("xy", () => {
        testRect(20, 20, { at: [10, 10] });
      });
      extrude(10).new();
    });
    insert(def);
    insert(def).translate(100, 0, 0);
    render();
    assertClean(scene);
    const ids = scene.getSerializedInstances().map(i => i.instanceId);

    const report = checkReport(scene);
    expect(report.ok).toBe(true);
    expect(report.bodies).toBe(4);
    expect(report.units).toBe(2);
    expect(report.clashes).toEqual([]);
    expect(report.intraPart).toHaveLength(2);
    expect(report.intraPart.map(p => p.a.instanceId).sort()).toEqual([...ids].sort());
    for (const pair of report.intraPart) {
      expect(pair.a.instanceId).toBe(pair.b.instanceId);
      expect(pair.volume).toBe(1000);
    }
    expect(report.checked).toBe(2);
    expect(report.rejectedByBounds).toBe(4);
  });

  it("one instance alone is inconclusive", () => {
    const scene = getSceneManager().startAssemblyScene();
    insert(boxDef());
    render();
    assertClean(scene);
    const report = checkReport(scene);
    expect(report.ok).toBe(false);
    expect(report.inconclusive).toContain('only one');
  });
});

describe("SceneInterference — units and payload", () => {
  setupOC();

  it("the default tolerance is 1 mm³ in the document unit cubed", () => {
    expect(SceneInterference.defaultTolerance('mm')).toBe(1);
    expect(SceneInterference.defaultTolerance('cm')).toBeCloseTo(1e-3, 12);
    expect(SceneInterference.defaultTolerance('m')).toBeCloseTo(1e-9, 15);
    expect(SceneInterference.defaultTolerance('in')).toBeCloseTo(1 / (25.4 ** 3), 12);
  });

  it("prices one clash entry", () => {
    const scene = makeTwoParts(0);
    const report = checkReport(scene);
    const clash = JSON.stringify(report.clashes[0]);
    // Two bodies of two UUIDs each (36 chars), names, part, volume.
    expect(clash.length).toBeLessThan(420);
    expect(clash).not.toMatch(/\d\.\d{7,}/);
    const bare = JSON.stringify({ ...report, clashes: [], intraPart: [], failed: [] });
    expect(bare.length).toBeLessThan(200);
  });
});
