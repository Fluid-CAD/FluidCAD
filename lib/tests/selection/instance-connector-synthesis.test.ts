import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import connector from "../../core/connector.js";
import insert from "../../core/insert.js";
import { rect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Part } from "../../features/part.js";
import { Instance } from "../../features/instance.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { suggestConnectorAnchors } from "../../selection/connector-anchors.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";
import type { PickRef } from "../../selection/types.js";

const ASSEMBLY_FILE = "/ws/rig.assembly.js";

describe("instance-scoped connector synthesis", () => {
  setupOC();

  /**
   * An assembly with two instances of a 100×50×30 box part. The part's
   * statements carry part-file locations; the inserts carry assembly-file
   * locations (line 3 and 4).
   */
  function makeAssembly(): {
    scene: AssemblyScene;
    a: Instance;
    b: Instance;
    topFace: PickRef;
  } {
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
    return { scene: rendered as AssemblyScene, a, b, topFace: tops[0] };
  }

  it("emits an assembly-file spec with the insert line and a forced select() form", () => {
    const { scene, a, topFace } = makeAssembly();

    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'pivot', [], {
      connector: { instance: { instanceId: a.record.instanceId } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.connector).toEqual({
        name: 'pivot',
        instance: { line: 3 },
      });
      expect(result.spec.filePath).toBe(ASSEMBLY_FILE);
      // No part-file statement is referenced — nothing to bind or anchor.
      expect(result.spec.producers).toHaveLength(0);
      expect(result.spec.parts).toHaveLength(1);
      // Forced geometric form: no producer accessor survives at assembly scope.
      expect(result.spec.parts[0].producer).toBeNull();
      expect(result.spec.parts[0].accessor).toBe('select');
      expect(result.spec.parts[0].filterArgs).toBeTruthy();
      // The picked face lies on the extrude's end-face plane, where a
      // plane-reference atom (`onPlane({{r0}}.endFaces())`) would otherwise
      // outrank the constant form — but its `{{r0}}` names a part-file
      // statement the assembly file cannot bind, so the forced select()
      // must synthesize reference-free filters only.
      expect(result.spec.parts[0].filterArgs).not.toContain('{{');
      expect(result.spec.parts[0].refs).toBeNull();
      // `select` renders as the instance binding's method — never imported.
      expect(result.spec.imports).not.toContain('select');
    }
  });

  it("refuses an instance that is not in the assembly", () => {
    const { scene, topFace } = makeAssembly();
    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'pivot', [], {
      connector: { instance: { instanceId: 'inst-99' } },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('no longer in the assembly');
    }
  });

  it("refuses a name taken by the part or by the instance's own connectors", () => {
    getSceneManager().startAssemblyScene();
    const p = part("housing", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 5);
      connector("mount", select(face().planar().onPlane("xy", 30)));
    }) as unknown as Part;
    setLocation(p, 2);
    const a = insert(p);
    a.record.sourceLocation = { filePath: ASSEMBLY_FILE, line: 3, column: 0 };
    connector("pivot", a.select(face().planar().onPlane("xy", 0)));
    const rendered = render() as AssemblyScene;
    const solid = findSolid(rendered);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    for (const taken of ["mount", "pivot"]) {
      const result = synthesizeApplyFeature(rendered, tops, 'connector', taken, [], {
        connector: { instance: { instanceId: a.record.instanceId } },
      });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toContain(`already has a connector named "${taken}"`);
      }
    }

    const fresh = synthesizeApplyFeature(rendered, tops, 'connector', 'pivot2', [], {
      connector: { instance: { instanceId: a.record.instanceId } },
    });
    expect(fresh.ok).toBe(true);
  });

  it("part-scoped synthesis on the same pick still targets the part file", () => {
    const { scene, topFace } = makeAssembly();
    const result = synthesizeApplyFeature(scene, [topFace], 'connector', 'mount');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.connector?.part).toEqual({ line: 2, column: 0 });
      expect(result.spec.connector?.instance).toBeUndefined();
      expect(result.spec.filePath).toBe('/ws/model.fluid.js');
    }
  });

  it("anchor suggestions skip names taken by the instance's connectors", () => {
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
    connector("c1", a.select(face().planar().onPlane("xy", 0)));
    const rendered = render() as AssemblyScene;
    const solid = findSolid(rendered);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const forA = suggestConnectorAnchors(rendered, tops[0], {
      connector: { instance: { instanceId: a.record.instanceId } },
    });
    expect(forA.ok).toBe(true);
    if (forA.ok) {
      expect(forA.defaultName).toBe('c2');
      expect(forA.filePath).toBe(ASSEMBLY_FILE);
    }

    // The other instance's namespace is untouched by a's connector.
    const forB = suggestConnectorAnchors(rendered, tops[0], {
      connector: { instance: { instanceId: b.record.instanceId } },
    });
    expect(forB.ok).toBe(true);
    if (forB.ok) {
      expect(forB.defaultName).toBe('c1');
    }
  });
});
