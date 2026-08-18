import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import expose from "../../core/expose.js";
import insert from "../../core/insert.js";
import { rect } from "../../core/2d/index.js";
import { face, edge } from "../../filters/index.js";
import { resolvePickExposure } from "../../selection/expose-lookup.js";
import { faceRefsWhere, edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

/**
 * Phase-A spike (17-mate-tangent §7.1): the assembly-scene refusal in
 * SceneManager.resolvePickExposure fired BEFORE attributePick /
 * findEnclosingPart, so those were unexercised over an assembly's part
 * templates. Tangent picks lift the refusal via `context: 'mate'` — these
 * tests pin down that the underlying attribution actually works there.
 */
describe("resolvePickExposure over an AssemblyScene", () => {
  setupOC();

  function makeAssembly(donorBody?: () => void) {
    getSceneManager().startScene();
    const donor = part("Donor", () => {
      sketch("xy", () => rect(100, 50));
      extrude(30);
      donorBody?.();
    });
    setLocation(donor, 2);
    const scene = getSceneManager().startAssemblyScene();
    insert(donor);
    insert(donor);
    const rendered = render();
    expect(rendered).toBe(scene);
    const solid = findSolid(rendered);
    return { scene, solid };
  }

  it("attributes a template face pick to its enclosing part (no exposure)", () => {
    const { scene, solid } = makeAssembly();
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);

    const result = resolvePickExposure(scene, tops[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.partName).toBe("Donor");
      expect(result.donor?.matched).toBe(null);
      expect(result.donor?.existingNames).toEqual([]);
    }
  });

  it("matches an existing exposure serving the picked face", () => {
    const { scene, solid } = makeAssembly(() => {
      expose("top", select(face().planar().onPlane("xy", 30)));
    });
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const result = resolvePickExposure(scene, tops[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.matched).toBe("top");
      expect(result.donor?.existingNames).toEqual(["top"]);
    }
  });

  it("matches an existing exposure serving a picked EDGE", () => {
    const { scene, solid } = makeAssembly(() => {
      expose("lip", select(edge().onPlane("xy", 30)));
    });
    const topEdges = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(topEdges.length).toBeGreaterThan(0);

    const result = resolvePickExposure(scene, topEdges[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.partName).toBe("Donor");
      expect(result.donor?.matched).toBe("lip");
    }
  });

  it("SceneManager wrapper: refuses by default, resolves with context 'mate'", () => {
    const { scene, solid } = makeAssembly(() => {
      expose("top", select(face().planar().onPlane("xy", 30)));
    });
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    const manager = getSceneManager();

    const refused = manager.resolvePickExposure(scene, tops[0]);
    expect(refused.ok).toBe(false);
    if ('reason' in refused) {
      expect(refused.reason).toMatch(/authored in the part file/i);
    }

    const allowed = manager.resolvePickExposure(scene, tops[0], { context: 'mate' });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.donor?.matched).toBe("top");
    }
  });
});
