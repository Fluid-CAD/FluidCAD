import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { FaceProps } from "../../oc/face-props.js";
import { Explorer } from "../../oc/explorer.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import type { PickRef } from "../../selection/types.js";
import { findSolid, setLocation } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

/**
 * Extrude's up-to-face target only reads the picked face's underlying
 * surface — the build resizes it to an infinite plane/cylinder/cone before
 * splitting. So a bore wall reshaped by later cuts, which belongs to no
 * bucket anymore, can still be named by its classified ancestor's accessor
 * (`c.internalFaces()`): the accessor resolves the as-built face, whose
 * surface is the same cylinder. Synthesis must prefer that topological name
 * over a scene-wide select() with a baked-in geometric constant.
 */
describe("extrude target re-homing", () => {
  setupOC();

  it("names a reshaped cut bore through the cut's accessor, not a geometric select", () => {
    sketch("xy", () => {
        testRect(100, 100, { at: [-50, -50] });
      });
    const e = extrude(40) as Extrude;
    setLocation(e, 5);

    // Bore ⌀40 through the box — its wall is the cut's internal face.
    sketch(e.endFaces(), () => {
        circle([0, 0], 40);
      });
    const c = cut(40);
    setLocation(c, 8);

    // Cross hole ⌀10 through everything at z=20 — pierces the bore wall,
    // so the picked face is no longer the cut's as-built internal face.
    sketch("xz", () => {
        circle([0, 20], 10);
      });
    const c2 = cut().symmetric();
    setLocation(c2, 11);

    const scene = render();
    const solid = findSolid(scene);

    // Pick the reshaped bore wall: the radius-20 cylindrical face.
    const refs: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const props = FaceProps.getProperties(f.getShape());
      if (props.surfaceType === 'cylinder' && props.radius !== undefined
        && Math.abs(props.radius - 20) < 1e-6) {
        refs.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    expect(refs.length).toBeGreaterThan(0);

    const result = synthesizeApplyFeature(scene, [refs[0]], 'extrude');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The winner binds the cut and uses its internal-faces accessor
      // instead of falling back to select(face().cylinder(40)).
      expect(result.args).toMatch(/internalFaces/);
      expect(result.args).not.toMatch(/select\(/);
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].featureType).toBe('cut');
    }
  });
});
