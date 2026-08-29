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
import { PlaneFromObject } from "../../features/plane-from-object.js";
import { Solid } from "../../common/solid.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeProps } from "../../oc/props.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

function sceneSolid(scene: Scene): Solid {
  return scene.getAllSceneObjects()
    .flatMap(o => o.getShapes())
    .find(sh => sh.getType() === "solid") as Solid;
}

/**
 * A fillet reshapes the extrude's top face, so the pick classifies into no
 * bucket and synthesis falls back to a scene-wide select(). The end face
 * still names the plane the pick lies on — `onPlane(e.endFaces())` reads the
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
      expect(result.preview).toBe("shell(-2, select(face().onPlane(e.endFaces())))");
      expect(result.spec.imports).toEqual(
        expect.arrayContaining(['select', 'face']),
      );
      // The referenced extrude rides the producers list so the transform
      // binds `e`; the part's token maps back to it.
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].featureType).toBe('extrude');
      expect(result.spec.parts[0].refs).toEqual([0]);
      expect(result.spec.parts[0].filterArgs).toBe(
        "face().onPlane({{r0}}.endFaces())",
      );
    }
  });

  it("falls back to the baked datum offset when the producer's statement cannot be bound", () => {
    // The transform refuses to reference a producer whose variable is
    // reassigned after the call (`let body; body = extrude(...); body =
    // shell(...)`). The server reports that through the `bindable` probe;
    // synthesis must then skip the plane reference — which would bind the
    // variable — and emit the constant datum form, which binds nothing.
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    setLocation(e, 6);
    const l = fillet(10, e.sideEdges());
    setLocation(l, 7);

    const scene = render();
    const solid = findSolid(scene);
    const refs = faceRefsWhere(solid, m => Math.abs(m.z - 25) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'shell', -2, [], {
      bindable: producer => producer.featureType !== 'extrude',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("shell(-2, select(face().onPlane('xy', 25)))");
      expect(result.spec.producers.filter(p => p.bind)).toHaveLength(0);
    }
  });

  it("routes a bucket-classified pick to the global tier when its producer cannot be bound", () => {
    // A pick that classifies straight into the extrude's end-face bucket
    // would normally emit `e.endFaces()` and bind `e`; when the statement
    // cannot be bound the pick must reroute through the variable-free
    // scene-wide select().
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    setLocation(e, 6);

    const scene = render();
    const solid = findSolid(scene);
    const refs = faceRefsWhere(solid, m => Math.abs(m.z - 25) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'shell', -2, [], {
      bindable: () => false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("shell(-2, select(face().onPlane('xy', 25)))");
      expect(result.spec.producers.filter(p => p.bind)).toHaveLength(0);
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

  it("the emitted plane-reference selector builds without adding a plane to the scene", () => {
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    fillet(10, e.sideEdges());
    const s = shell(-2, select(face().onPlane(e.endFaces())));

    const scene = render();
    expect((s as Shell).getError()).toBeNull();

    // The reference is internal to the filter — unlike plane(e.endFaces()),
    // no derived-plane feature enters the scene, so nothing renders and
    // nothing needs consuming. (The sketch's own base plane still exists.)
    expect(scene.getAllSceneObjects().some(o => o instanceof PlaneFromObject)).toBe(false);

    const solid = sceneSolid(scene);
    expect(solid).toBeDefined();
    // Hollowed: well under the filleted prism's full volume.
    expect(ShapeProps.getProperties(solid.getShape()).volumeMm3)
      .toBeLessThan(123.28 * 56.07 * 25 * 0.5);
  });

  it("the plane()-wrapped form still resolves (back-compat)", () => {
    sketch("xy", () => {
      rect(123.28, 56.07).centered();
    });
    const e = extrude(25) as Extrude;
    fillet(10, e.sideEdges());
    const s = shell(-2, select(face().onPlane(plane(e.endFaces()))));

    const scene = render();
    expect((s as Shell).getError()).toBeNull();
    expect(ShapeProps.getProperties(sceneSolid(scene).getShape()).volumeMm3)
      .toBeLessThan(123.28 * 56.07 * 25 * 0.5);
  });
});
