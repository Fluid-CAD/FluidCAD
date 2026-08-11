import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import shell from "../../core/shell.js";
import select from "../../core/select.js";
import plane from "../../core/plane.js";
import { rect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";
import { Shell } from "../../features/shell.js";
import { Solid } from "../../common/solid.js";
import { ShapeProps } from "../../oc/props.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

/**
 * A fillet reshapes the extrude's top face, so the pick classifies into no
 * bucket and synthesis falls back to a scene-wide select(). The end face
 * still names the plane the pick lies on — `plane(e.endFaces())` reads the
 * plane off the recorded as-built face even though the solid was consumed —
 * and unlike `onPlane('xy', 25)` it survives a change of the extrusion
 * distance.
 */
describe("plane-reference selectors", () => {
  setupOC();

  it("names a reshaped end face through the producer's plane, not a baked offset", () => {
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    setLocation(e, 6);
    fillet(10, e.sideEdges());

    const scene = render();
    const solid = findSolid(scene);
    const refs = faceRefsWhere(solid, m => Math.abs(m.z - 25) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'shell', -2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("shell(-2, select(face().onPlane(plane(e.endFaces()))))");
      expect(result.spec.imports).toEqual(
        expect.arrayContaining(['select', 'face', 'plane']),
      );
      // The referenced extrude rides the producers list so the transform
      // binds `e`; the part's token maps back to it.
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].featureType).toBe('extrude');
      expect(result.spec.parts[0].refs).toEqual([0]);
      expect(result.spec.parts[0].filterArgs).toBe(
        "face().onPlane(plane({{r0}}.endFaces()))",
      );
    }
  });

  it("still prefers the bare datum plane when the pick lies on one", () => {
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    setLocation(e, 6);
    const l = fillet(10, e.sideEdges());
    // The datum form references no producer, so the pure-select() statement
    // anchors its insertion on a located feature.
    setLocation(l, 7);

    const scene = render();
    const solid = findSolid(scene);
    const refs = faceRefsWhere(solid, m => Math.abs(m.z) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'shell', -2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("shell(-2, select(face().onPlane('xy')))");
    }
  });

  it("the emitted plane-reference selector builds and shells the solid", () => {
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    fillet(10, e.sideEdges());
    const s = shell(-2, select(face().onPlane(plane(e.endFaces()))));

    const scene = render();
    expect((s as Shell).getError()).toBeNull();

    const solid = scene.getAllSceneObjects()
      .flatMap(o => o.getShapes())
      .find(sh => sh.getType() === "solid") as Solid;
    expect(solid).toBeDefined();

    const props = ShapeProps.getProperties(solid.getShape());
    // Hollowed: well under the filleted prism's full volume.
    expect(props.volumeMm3).toBeLessThan(123.28 * 56.07 * 25 * 0.5);
  });
});
