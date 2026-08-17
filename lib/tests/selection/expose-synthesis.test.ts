import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import expose from "../../core/expose.js";
import { rect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

describe("expose synthesis", () => {
  setupOC();

  /** One part around a 100×50×30 box; the part's call site is line 2. */
  function makePartScene(): { scene: Scene; topFace: ReturnType<typeof faceRefsWhere>[number] } {
    const p = part("housing", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 5);
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);
    return { scene, topFace: tops[0] };
  }

  it("synthesizes a named exposure spec carrying the part's call site", () => {
    const { scene, topFace } = makePartScene();

    const result = synthesizeApplyFeature(scene, [topFace], 'expose', 'endFace');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe(`expose('endFace', ${result.args})`);
      expect(result.spec.expose).toEqual({
        name: 'endFace',
        part: { line: 2, column: 0 },
      });
      // The name rides the payload, not the numeric value channel.
      expect(result.spec.value).toBeUndefined();
      expect(result.spec.parts).toHaveLength(1);
    }
  });

  it("refuses a pick outside any part() block", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 3);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const result = synthesizeApplyFeature(scene, tops, 'expose', 'endFace');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('part()');
    }
  });

  it("refuses a name the part already exposes", () => {
    const p = part("housing", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 5);
      expose("endFace", select(face().planar().onPlane("xy", 30)));
    });
    setLocation(p, 2);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, tops, 'expose', 'endFace');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('already exposes "endFace"');
    }

    // A fresh name on the same pick is fine, and connectors don't collide:
    // the two namespaces are separate.
    const fresh = synthesizeApplyFeature(scene, tops, 'expose', 'endFace2');
    expect(fresh.ok).toBe(true);
  });

  it("refuses more than one pick", () => {
    const { scene, topFace } = makePartScene();
    const solid = findSolid(scene);
    const bottoms = faceRefsWhere(solid, m => Math.abs(m.z) < 1e-6);
    expect(bottoms).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, [topFace, bottoms[0]], 'expose', 'endFace');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('exactly one');
    }
  });

  it("refuses a missing or non-identifier name", () => {
    const { scene, topFace } = makePartScene();

    for (const bad of [undefined, 4, '', 'top left', '1st'] as const) {
      const result = synthesizeApplyFeature(scene, [topFace], 'expose', bad as any);
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toContain('name');
      }
    }
  });
});
