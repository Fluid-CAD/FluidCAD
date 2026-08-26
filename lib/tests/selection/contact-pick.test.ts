import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import expose from "../../core/expose.js";
import insert from "../../core/insert.js";
import { face } from "../../filters/index.js";
import { testRectSketch } from "../helpers/profiles.js";
import { resolveContactPick } from "../../selection/contact-pick.js";
import { faceRefsWhere, edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

// The tangent-mate pick resolver (17-mate-tangent §7.3): one call serves
// the find-or-create exposure data AND the contact classification the
// provisional solve consumes — over the assembly scene's part templates.
describe("resolveContactPick", () => {
  setupOC();

  function makeAssembly(donorBody?: (e: ReturnType<typeof extrude>) => void) {
    getSceneManager().startScene();
    const donor = part("Donor", () => {
      testRectSketch("xy", 40, 20);
      const e = extrude(10);
      donorBody?.(e);
    });
    setLocation(donor, 2);
    const scene = getSceneManager().startAssemblyScene();
    insert(donor);
    render();
    const solid = findSolid(scene);
    return { scene, solid };
  }

  it("classifies a face pick and reports the donor with no match", () => {
    const { scene, solid } = makeAssembly();
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
    const result = resolveContactPick(scene, tops[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.partName).toBe("Donor");
      expect(result.donor?.matched).toBe(null);
      expect(result.seed?.form).toBe("plane");
      expect(result.seed?.dir[2]).toBeCloseTo(1, 6);
      expect(result.chain).toHaveLength(1);
    }
  });

  it("matches an existing exposure and walks the fillet chain", () => {
    const { scene, solid } = makeAssembly((e) => {
      fillet(3, e.endEdges());
      expose("top", select(face().planar().onPlane("xy", 10)));
    });
    // Rounded slab: the (shrunken) top face's edge midpoints all sit at z=10.
    const topRefs = faceRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
    expect(topRefs.length).toBeGreaterThan(0);
    const result = resolveContactPick(scene, topRefs[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.matched).toBe("top");
      expect(result.seed?.form).toBe("plane");
      // Top + 4 fillets + 4 sides (G1 through the fillets).
      expect(result.chain.filter(c => c.form === "cylinder")).toHaveLength(4);
      expect(result.chain.filter(c => c.form === "plane")).toHaveLength(5);
    }
  });

  it("classifies an EDGE pick (line form, param bounds)", () => {
    const { scene, solid } = makeAssembly();
    const topEdges = edgeRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
    const result = resolveContactPick(scene, topEdges[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.seed?.form).toBe("line");
      expect(result.donor?.partName).toBe("Donor");
      const span = result.seed!.bounds!.uMax - result.seed!.bounds!.uMin;
      expect([20, 40].some(l => Math.abs(span - l) < 1e-4)).toBe(true);
    }
  });

  it("reaches the resolver through the SceneManager", () => {
    const { scene, solid } = makeAssembly();
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
    const result = getSceneManager().resolveContactPick(scene, tops[0]);
    expect(result.ok).toBe(true);
  });
});
