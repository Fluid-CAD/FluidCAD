import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import { Part } from "../../features/part.js";
import type { Extrude } from "../../features/extrude.js";
import { Scene } from "../../rendering/scene.js";
import { Solid } from "../../common/solid.js";
import { Explorer } from "../../oc/explorer.js";
import { SceneValidator } from "../../validation/scene-validator.js";
import type { SceneValidationOutcome, SceneValidationReport, ValidateSceneRequest } from "../../validation/scene-validator.js";

function assertClean(scene: Scene): void {
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
}

/** A 40×40×10 base and a 10×10×30 pillar, each its own part. */
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
  assertClean(scene);
  return scene;
}

function partNamed(scene: Scene, name: string): Part {
  const found = scene.getAllSceneObjects().find((o): o is Part => o instanceof Part && o.partName === name);
  expect(found).toBeDefined();
  return found!;
}

function extrudeIn(scene: Scene, partName: string) {
  const owner = partNamed(scene, partName);
  const found = scene.getAllSceneObjects().find(o => o.getType() === 'extrude' && scene.findEnclosingPart(o) === owner);
  expect(found).toBeDefined();
  return found!;
}

/**
 * Turn a rendered extrude's solid inside out in place, keeping its shape id
 * so the rendered-shape lookup still finds it. The DSL cannot produce an
 * inverted body; this is the failure the scene-level path must attribute
 * to the right object and part.
 */
function invertRenderedSolid(scene: Scene, objectId: string): string {
  const object = scene.getSceneObjectById(objectId)!;
  const shapes = object.getAddedShapes();
  const index = shapes.findIndex(s => s.getType() === 'solid');
  expect(index).toBeGreaterThanOrEqual(0);
  const original = shapes[index];
  const reversed = Solid.fromTopoDSSolid(Explorer.toSolid(original.getShape().Reversed()));
  reversed.id = original.id;
  shapes[index] = reversed;
  return original.id;
}

function validateReport(scene: Scene, request?: ValidateSceneRequest): SceneValidationReport {
  const outcome = SceneValidator.validate(scene, request);
  expect(outcome.kind, outcome.kind === 'refused' ? outcome.reason : '').toBe('report');
  return (outcome as Extract<SceneValidationOutcome, { kind: 'report' }>).report;
}

function validateRefusal(scene: Scene, request: ValidateSceneRequest): Extract<SceneValidationOutcome, { kind: 'refused' }> {
  const outcome = SceneValidator.validate(scene, request);
  expect(outcome.kind).toBe('refused');
  return outcome as Extract<SceneValidationOutcome, { kind: 'refused' }>;
}

describe("SceneValidator — part files", () => {
  setupOC();

  it("a sound part reports no findings, one shape per rendered solid, with counts and a rounded volume", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const box = extrude(10) as Extrude;
    const scene = render();
    assertClean(scene);

    const report = validateReport(scene);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.shapes).toHaveLength(1);
    expect(report.shapes[0]).toEqual({
      shapeId: box.getShapes({}, 'solid')[0].id,
      sceneObjectId: box.id,
      sceneObjectName: box.getName(),
      part: null,
      faces: 6,
      edges: 12,
      solids: 1,
      volume: 4000,
      findings: [],
    });
    expect(report.unit).toBe('mm');
    expect(report.checks).toEqual(['invalidTopology', 'openShell', 'nonPositiveVolume', 'noSolid']);
    expect(report.notChecked.selfIntersecting).toContain('not checked');
  });

  it("only the solids the scene renders are examined: a consumed extrude is not, the cut result is", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const box = extrude(10) as Extrude;
    sketch(box.endFaces(), () => {
      testRect(5, 5, { at: [7.5, 7.5] });
    });
    const hole = cut(10) as Extrude;
    const scene = render();
    assertClean(scene);

    const report = validateReport(scene);
    expect(report.checked).toBe(1);
    expect(report.shapes[0].sceneObjectId).toBe(hole.id);
    expect(report.shapes[0].sceneObjectId).not.toBe(box.id);
    expect(report.shapes[0].volume).toBe(4000 - 250);
  });

  it("an inverted solid in a two-part file is reported against the right part, and the analyzer alone would have passed it", () => {
    const scene = makeTwoParts();
    const pillar = extrudeIn(scene, "pillar");
    const shapeId = invertRenderedSolid(scene, pillar.id);

    const report = validateReport(scene);
    expect(report.ok).toBe(false);
    expect(report.checked).toBe(2);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      kind: 'nonPositiveVolume',
      shapeId,
      sceneObjectId: pillar.id,
      part: 'pillar',
    });
    expect(report.findings[0].message).toContain('reversed');
    expect(report.findings[0].instanceIds).toBeUndefined();

    const byPart = new Map(report.shapes.map(s => [s.part, s]));
    expect(byPart.get('base')!.findings).toEqual([]);
    expect(byPart.get('base')!.volume).toBe(16000);
    expect(byPart.get('pillar')!.findings).toEqual(['nonPositiveVolume']);
    expect(byPart.get('pillar')!.volume).toBe(-3000);
  });

  it("shapeIds narrows the check and an unknown id is refused", () => {
    const scene = makeTwoParts();
    const base = extrudeIn(scene, "base");
    const baseShape = base.getShapes({}, 'solid')[0].id;

    const report = validateReport(scene, { shapeIds: [baseShape, baseShape] });
    expect(report.checked).toBe(1);
    expect(report.shapes[0].part).toBe('base');

    const refusal = validateRefusal(scene, { shapeIds: [baseShape, 'nope'] });
    expect(refusal.code).toBe('unknown-shape');
    expect(refusal.reason).toContain('"nope"');
    expect(refusal.reason).not.toContain(baseShape);
  });

  it("an explicitly named non-solid shape is noSolid rather than silently dropped", () => {
    const outline = sketch("xy", () => {
      testRect(20, 20);
    });
    const scene = render();
    assertClean(scene);
    // Default pool: nothing is a solid, so nothing is checked and the report is clean-but-empty.
    expect(validateReport(scene)).toMatchObject({ ok: true, checked: 0, shapes: [], findings: [] });

    const rendered = scene.getRenderedObjects().find(r => r.visible && r.sceneShapes.length > 0 && !r.isContainer);
    expect(rendered, 'the sketch renders some geometry').toBeDefined();
    const shapeId = rendered!.sceneShapes[0].shapeId;
    const report = validateReport(scene, { shapeIds: [shapeId] });
    expect(report.checked).toBe(1);
    expect(report.findings.map(f => f.kind)).toEqual(['noSolid']);
    expect(report.shapes[0].volume).toBeUndefined();
    expect(outline).toBeDefined();
  });

  it("instanceId in a part file is refused", () => {
    const scene = makeTwoParts();
    const refusal = validateRefusal(scene, { instanceId: 'inst-1' });
    expect(refusal.code).toBe('not-an-assembly');
  });
});

describe("SceneValidator — assemblies", () => {
  setupOC();

  it("two instances of one part validate the prototype once and list both instance ids", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("box", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
    });
    insert(def);
    insert(def).translate(40, 0, 0);
    render();
    assertClean(scene);
    const ids = scene.getSerializedInstances().map(i => i.instanceId);
    expect(ids).toHaveLength(2);

    const report = validateReport(scene);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(report.shapes[0].part).toBe('box');
    expect(report.shapes[0].instanceIds).toEqual(ids);
    expect(report.shapes[0].volume).toBe(4000);

    // A defect in the prototype is one finding that names every instance.
    const pillar = scene.getSceneObjectById(report.shapes[0].sceneObjectId)!;
    invertRenderedSolid(scene, pillar.id);
    const broken = validateReport(scene);
    expect(broken.ok).toBe(false);
    expect(broken.findings).toHaveLength(1);
    expect(broken.findings[0].instanceIds).toEqual(ids);
    expect(broken.findings[0].part).toBe('box');
  });

  it("instanceId scopes the check to that instance's part and an unknown instance is refused", () => {
    const scene = getSceneManager().startAssemblyScene();
    const small = part("small", () => {
      sketch("xy", () => {
        testRect(10, 10);
      });
      extrude(10);
    });
    const large = part("large", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(20);
    });
    insert(small);
    insert(large).translate(50, 0, 0);
    insert(large).translate(100, 0, 0);
    render();
    assertClean(scene);
    const instances = scene.getSerializedInstances();
    expect(instances.map(i => i.partName)).toEqual(['small', 'large', 'large']);

    const all = validateReport(scene);
    expect(all.checked).toBe(2);
    expect(all.shapes.map(s => s.part).sort()).toEqual(['large', 'small']);

    const largeOnly = validateReport(scene, { instanceId: instances[1].instanceId });
    expect(largeOnly.checked).toBe(1);
    expect(largeOnly.shapes[0].part).toBe('large');
    expect(largeOnly.shapes[0].instanceIds).toEqual([instances[1].instanceId, instances[2].instanceId]);
    expect(largeOnly.shapes[0].volume).toBe(8000);

    const refusal = validateRefusal(scene, { instanceId: 'nope' });
    expect(refusal.code).toBe('unknown-instance');
  });
});

describe("SceneValidator — payload", () => {
  setupOC();

  it("prices one finding and one shape entry", () => {
    const scene = makeTwoParts();
    invertRenderedSolid(scene, extrudeIn(scene, "pillar").id);
    const report = validateReport(scene);
    const finding = JSON.stringify(report.findings[0]);
    const shape = JSON.stringify(report.shapes[0]);
    // Ids are UUIDs (36 chars each, two per entry); the rest is the finding.
    expect(finding.length).toBeLessThan(320);
    expect(shape.length).toBeLessThan(260);
    // Numbers are rounded, never 16-digit floats.
    expect(shape).not.toMatch(/\d\.\d{7,}/);
  });
});
