import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import revolve from "../../core/revolve.js";
import plane from "../../core/plane.js";
import repeat from "../../core/repeat.js";
import { circle, line, arc, project } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { Explorer } from "../../oc/explorer.js";
import { FaceQuery } from "../../oc/face-query.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { DirectFaces } from "../../oc/direct-faces.js";
import { testRect } from "../helpers/profiles.js";

// Regression for the mirrored-boss defect (upper-alignment-clamp, 2026-09-15):
// OCCT gives a swept cylinder a left-handed frame when the profile circle's
// axis points against the sweep (a clockwise sketch arc, a reversed plane, a
// negative extrude or a mirror all do it), and ShapeUpgrade_UnifySameDomain —
// the face merge run after every fuse and cut — corrupts the body when it
// merges two coincident equal-radius cylinders of opposite handedness. The
// merge entry points detect such a pair and rebuild the left-handed faces to
// direct frames first (DirectFaces); every other body is left untouched.
describe("DirectFaces: coincident cylinders of opposite handedness merge cleanly", () => {
  setupOC();

  const X = 6.876117192717188;
  const Z = 45 + Math.sqrt(64 - X * X);

  function solids(scene: Scene): Shape[] {
    return scene.getSceneObjects()
      .filter(o => !o.isContainer())
      .flatMap(o => o.getShapes())
      .filter(s => s.isSolid());
  }

  function r8Faces(body: Shape) {
    return Explorer.findFacesWrapped(body).filter(f =>
      FaceQuery.getSurfaceType(f) === 'cylinder'
      && Math.abs(FaceQuery.getSurfaceAdaptorCylinderRaw(f.getShape()).Radius() - 8) < 1e-6);
  }

  function hub(): ExtrudeBase {
    sketch("xz", () => { arc([31, 0], [-31, 0], [0, 0]); line([-31, 0], [31, 0]); });
    return extrude(66).symmetric() as ExtrudeBase;
  }

  /** The clamp's ear: a triangle with an r=8 rounded top, cap arc drawn cw or ccw. */
  function ear(e: ExtrudeBase, offset: number, winding: 'cw' | 'ccw' = 'cw'): ExtrudeBase {
    sketch(plane("xz", offset), () => {
      project(e.startEdges(edge().arc()));
      if (winding === 'cw') {
        line([-26.64495412367585, 15.844444444223884], [-X, Z]);
        arc([-X, Z], [X, Z], [0, 45]).cw();
        line([X, Z], [26.644954124457655, 15.844444444572154]);
      } else {
        line([26.644954124457655, 15.844444444572154], [X, Z]);
        arc([X, Z], [-X, Z], [0, 45]);
        line([-X, Z], [-26.64495412367585, 15.844444444223884]);
      }
    });
    return extrude(11) as ExtrudeBase;
  }

  /** The r=8 boss sharing the ear's rounded-top cylinder, extruded back to the ear's start face. */
  function boss(target: ExtrudeBase): ExtrudeBase {
    sketch(plane("xz", 35), () => { circle([0, 45], 16); });
    return extrude(target.startFaces()) as ExtrudeBase;
  }

  function clamp(winding: 'cw' | 'ccw'): Shape[] {
    const e = hub();
    const e2 = ear(e, 20, winding);
    const f = boss(e2);
    repeat("mirror", "xz", e2, f);
    const scene = render();
    expect(scene.getSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
    return solids(scene);
  }

  it("mirrored ear + up-to-face boss with a clockwise cap arc is one valid body", () => {
    const bodies = clamp('cw');
    expect(bodies.length).toBe(1);
    expect(ShapeValidator.validate(bodies[0].getShape()).findings).toEqual([]);
    // One merged r=8 cylinder per side (ear top + boss).
    expect(r8Faces(bodies[0]).length).toBe(2);
  });

  it("the clockwise and counter-clockwise drawings build the same body", () => {
    const cw = clamp('cw');
    const cwVolume = ShapeProps.getProperties(cw[0].getShape()).volumeMm3;
    const cwFaces = Explorer.findFacesWrapped(cw[0]).length;

    getSceneManager().startScene();
    const ccw = clamp('ccw');
    expect(ccw.length).toBe(1);
    expect(ShapeValidator.validate(ccw[0].getShape()).findings).toEqual([]);
    expect(r8Faces(ccw[0]).length).toBe(2);

    expect(cwVolume).toBeCloseTo(ShapeProps.getProperties(ccw[0].getShape()).volumeMm3, 3);
    expect(cwFaces).toBe(Explorer.findFacesWrapped(ccw[0]).length);
  });

  it("detects the mixed pair, and only that", () => {
    const e = hub();
    const cwEar = ear(e, 20, 'cw').new();
    sketch(plane("xz", 35), () => { circle([0, 45], 16); });
    const bossBody = extrude(-15).new() as ExtrudeBase;
    const ccwEar = ear(e, -31, 'ccw').new();
    sketch("xy", () => { testRect(31.8, 15.8); });
    const brick = extrude(9.6).new() as ExtrudeBase;
    render();

    // Raw compound: the wrapped helper reduces a compound to its first solid.
    const pair = (a: ExtrudeBase, b: ExtrudeBase) =>
      ShapeOps.makeCompoundRaw([...a.getShapes(), ...b.getShapes()].map(s => s.getShape()));
    // cw ear top (left-handed) against the boss (right-handed): the pair.
    expect(DirectFaces.hasMixedHandedness(pair(cwEar, bossBody))).toBe(true);
    // ccw ear top against the same boss: same-handed, nothing to rebuild.
    expect(DirectFaces.hasMixedHandedness(pair(ccwEar, bossBody))).toBe(false);
    // Unrelated bodies never trigger.
    expect(DirectFaces.hasMixedHandedness(pair(brick, bossBody))).toBe(false);
    expect(DirectFaces.hasMixedHandedness(brick.getShapes()[0].getShape())).toBe(false);
  });

  it("a rebuilt full cylinder keeps its seam consistent", () => {
    // A full cylinder swept on xy is left-handed; a revolved cylinder of the
    // same radius stacked on it is right-handed. The fuse merges them into
    // one valid wall, which exercises the seam's two-pcurve period shift.
    sketch("xy", () => { circle([0, 0], 30); });
    extrude(50);
    sketch("xz", () => {
      line([0, 50], [15, 50]); line([15, 50], [15, 70]); line([15, 70], [0, 70]); line([0, 70], [0, 50]);
    });
    revolve("z", 360);
    const scene = render();
    expect(scene.getSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
    const bodies = solids(scene);
    expect(bodies.length).toBe(1);
    expect(ShapeValidator.validate(bodies[0].getShape()).findings).toEqual([]);
    const r15 = Explorer.findFacesWrapped(bodies[0]).filter(f =>
      FaceQuery.getSurfaceType(f) === 'cylinder'
      && Math.abs(FaceQuery.getSurfaceAdaptorCylinderRaw(f.getShape()).Radius() - 15) < 1e-6);
    expect(r15.length).toBe(1);
    expect(ShapeProps.getProperties(bodies[0].getShape()).volumeMm3).toBeCloseTo(Math.PI * 15 * 15 * 70, 0);
  });
});
