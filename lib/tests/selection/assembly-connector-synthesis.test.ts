import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { rect } from "../../core/2d/index.js";
import { Part } from "../../features/part.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { suggestConnectorAnchors } from "../../selection/connector-anchors.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";
import type { PickRef } from "../../selection/types.js";

const ASSEMBLY_FILE = "/ws/rig.assembly.js";

/**
 * Connector synthesis under an ASSEMBLY render: the Connector tool works on
 * assembly scenes too, but the statement always lands in the picked part's
 * own file (connectors are part-owned — assembly-scoped connectors were
 * removed). An assembly with two instances of a 100×50×30 box part; the
 * part's statements carry part-file locations, the inserts assembly-file
 * ones.
 */
describe("connector synthesis on an assembly render", () => {
  setupOC();

  function makeAssembly(): { scene: AssemblyScene; topFace: PickRef } {
    getSceneManager().startAssemblyScene();
    const p = part("housing", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 5);
    }) as unknown as Part;
    setLocation(p, 2);
    const a = insert(p);
    a.record.sourceLocation = { filePath: ASSEMBLY_FILE, line: 3, column: 0 };
    const b = insert(p);
    b.record.sourceLocation = { filePath: ASSEMBLY_FILE, line: 4, column: 0 };
    const rendered = render() as AssemblyScene;
    const solid = findSolid(rendered);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);
    return { scene: rendered, topFace: tops[0] };
  }

  it("targets the picked part's own file, not the assembly file", () => {
    const { scene, topFace } = makeAssembly();
    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'mount');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.connector?.part).toEqual({ line: 2, column: 0 });
      expect(result.spec.filePath).toBe('/ws/model.fluid.js');
    }
  });

  it("suggests anchors with the part file and a part-unique default name", () => {
    const { scene, topFace } = makeAssembly();
    const suggestion = suggestConnectorAnchors(scene, topFace);
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.defaultName).toBe('c1');
      expect(suggestion.filePath).toBe('/ws/model.fluid.js');
      expect(suggestion.anchors.length).toBeGreaterThan(0);
    }
  });
});
