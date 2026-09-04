import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import part from "../../core/part.js";
import assembly from "../../core/assembly.js";
import insert from "../../core/insert.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { testRect } from "../helpers/profiles.js";
import { readStepBack, stlBounds } from "./helpers.js";
import type { AssemblyExportPose } from "../../io/assembly-export/index.js";

/** A 20×20×10 block on the origin corner: centroid (10, 10, 5). */
function blockDefinition(name = "block", paint?: string) {
  return part(name, () => {
    sketch("xy", () => { testRect(20, 20); });
    const body = extrude(10);
    if (paint) {
      color(paint, body);
    }
  });
}

/** A part that builds no solid at all — only a sketch. */
function wireOnlyDefinition(name = "outline") {
  return part(name, () => {
    sketch("xy", () => { testRect(5, 5); });
  });
}

function startAssembly(): AssemblyScene {
  getSceneManager().startScene();
  return getSceneManager().startAssemblyScene();
}

function count(text: string, entity: string): number {
  return text.split(entity).length - 1;
}

/** Centre of mass of every solid in the shape, sorted by x then y then z. */
function centroids(step: string): [number, number, number][] {
  const oc = getOC();
  const shape = readStepBack(step);
  const solids = Explorer.findShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
  const points = solids.map((solid): [number, number, number] => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
    const c = props.CentreOfMass();
    const point: [number, number, number] = [c.X(), c.Y(), c.Z()];
    props.delete();
    return point;
  });
  return points
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .map(p => p.map(v => +v.toFixed(3)) as [number, number, number]);
}

function exportCurrent(options: { format: 'step' | 'stl'; livePoses?: AssemblyExportPose[]; includeColors?: boolean; scaleTo?: 'mm' | 'document' }) {
  return getSceneManager().exportAssembly(getCurrentScene(), { name: "rig", ...options });
}

function exportedStep(options: { livePoses?: AssemblyExportPose[]; includeColors?: boolean } = {}): string {
  const outcome = exportCurrent({ format: "step", ...options });
  if ('reason' in outcome) {
    throw new Error(outcome.reason);
  }
  return outcome.data as string;
}

describe("assembly export", () => {
  setupOC();

  it("writes each instance where it sits, sharing one body per part", () => {
    startAssembly();
    const block = blockDefinition();
    insert(block);
    insert(block).translate(100, 0, 0);
    render();

    const step = exportedStep();

    // One prototype, two placements.
    expect(count(step, "MANIFOLD_SOLID_BREP")).toBe(1);
    expect(count(step, "NEXT_ASSEMBLY_USAGE_OCCURRENCE")).toBe(2);
    expect(centroids(step)).toEqual([[10, 10, 5], [110, 10, 5]]);
  });

  it("names the products after the assembly, the parts and the instances", () => {
    startAssembly();
    const block = blockDefinition("housing");
    insert(block).name("left housing");
    render();

    const step = exportedStep();

    expect(step).toContain("PRODUCT('rig'");
    expect(step).toContain("PRODUCT('housing'");
    // NAUO(id, name, description, ...): the instance name is the second field.
    expect(step).toMatch(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('[^']*','left housing'/);
  });

  it("places instances by the client's live poses when given", () => {
    startAssembly();
    const block = blockDefinition();
    const a = insert(block);
    const b = insert(block).translate(100, 0, 0);
    render();

    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const step = exportedStep({
      livePoses: [
        { instanceId: a.record.instanceId, position: { x: 0, y: 50, z: 0 }, quaternion: identity },
        { instanceId: b.record.instanceId, position: { x: 0, y: 0, z: 0 }, quaternion: identity },
      ],
    });

    expect(centroids(step)).toEqual([[10, 10, 5], [10, 60, 5]]);
  });

  it("refuses a live-pose list that does not cover every instance", () => {
    startAssembly();
    const block = blockDefinition();
    const a = insert(block);
    insert(block).name("second");
    render();

    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const outcome = exportCurrent({
      format: "step",
      livePoses: [{ instanceId: a.record.instanceId, position: { x: 0, y: 0, z: 0 }, quaternion: identity }],
    });

    expect('reason' in outcome && outcome.reason).toMatch(/second/);
  });

  it("refuses a live pose for an instance the scene does not have", () => {
    startAssembly();
    insert(blockDefinition());
    render();

    const outcome = exportCurrent({
      format: "step",
      livePoses: [{ instanceId: "inst-99", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }],
    });

    expect('reason' in outcome && outcome.reason).toMatch(/inst-99/);
  });

  it("nests sub-assemblies and composes their frames", () => {
    startAssembly();
    const block = blockDefinition();
    const sub = assembly("carriage", () => ({ b: insert(block).translate(5, 0, 0) }));
    insert(sub).translate(0, 100, 0);
    insert(block);
    render();

    const step = exportedStep();

    // root→carriage, carriage→block, root→block.
    expect(count(step, "NEXT_ASSEMBLY_USAGE_OCCURRENCE")).toBe(3);
    expect(step).toContain("PRODUCT('carriage'");
    expect(centroids(step)).toEqual([[10, 10, 5], [15, 110, 5]]);
  });

  it("keeps a live pose exact inside a sub-assembly frame", () => {
    startAssembly();
    const block = blockDefinition();
    const sub = assembly("carriage", () => ({ b: insert(block) }));
    const occ = insert(sub).translate(0, 100, 0).rotate("z", 90);
    render();

    // The solver moved the nested instance to a world spot unrelated to
    // its frame's statement pose: the export must land it there anyway.
    const step = exportedStep({
      livePoses: [{
        instanceId: occ.parts.b.record.instanceId,
        position: { x: 200, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
      }],
    });

    expect(centroids(step)).toEqual([[210, 10, 5]]);
  });

  it("keeps colours on the shared prototype", () => {
    startAssembly();
    const block = blockDefinition("block", "#3366cc");
    insert(block);
    insert(block).translate(50, 0, 0);
    render();

    const painted = exportedStep();
    expect(painted).toContain("COLOUR_RGB");
    expect(count(painted, "NEXT_ASSEMBLY_USAGE_OCCURRENCE")).toBe(2);

    const plain = exportedStep({ includeColors: false });
    expect(plain).not.toContain("COLOUR_RGB");
    expect(count(plain, "NEXT_ASSEMBLY_USAGE_OCCURRENCE")).toBe(2);
  });

  it("flattens every placed copy into one STL", () => {
    startAssembly();
    const block = blockDefinition();
    insert(block);
    insert(block).translate(100, 0, 0);
    render();

    const outcome = exportCurrent({ format: "stl" });
    if ('reason' in outcome) {
      throw new Error(outcome.reason);
    }
    expect(outcome.fileName).toBe("rig.stl");
    const bounds = stlBounds(outcome.data as Uint8Array);
    expect(bounds.min.map(v => +v.toFixed(3))).toEqual([0, 0, 0]);
    expect(bounds.max.map(v => +v.toFixed(3))).toEqual([120, 20, 10]);
  });

  it("reports which poses were written", () => {
    startAssembly();
    const a = insert(blockDefinition());
    render();

    const statement = exportCurrent({ format: "step" });
    expect(!('reason' in statement) && statement.posesSource).toBe("statement");
    expect(!('reason' in statement) && statement.fileName).toBe("rig.step");

    const live = exportCurrent({
      format: "step",
      livePoses: [{ instanceId: a.record.instanceId, position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }],
    });
    expect(!('reason' in live) && live.posesSource).toBe("live");
  });

  it("refuses a part scene", () => {
    getSceneManager().startScene();
    sketch("xy", () => { testRect(10, 10); });
    extrude(5);
    render();

    const outcome = exportCurrent({ format: "step" });
    expect('reason' in outcome && outcome.reason).toMatch(/assembly/);
  });

  it("skips parts without solids and fails only when nothing is left", () => {
    startAssembly();
    const block = blockDefinition();
    insert(block);
    insert(wireOnlyDefinition());
    render();

    const step = exportedStep();
    expect(count(step, "NEXT_ASSEMBLY_USAGE_OCCURRENCE")).toBe(1);

    startAssembly();
    insert(wireOnlyDefinition());
    render();
    expect(() => exportCurrent({ format: "step" })).toThrow(/no solids/);
  });
});
