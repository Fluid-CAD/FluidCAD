import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import shell from "../../core/shell.js";
import select from "../../core/select.js";
import { circle, offset, project, origin } from "../../core/2d/index.js";
import { coincident, diameter } from "../../core/constraints/index.js";
import { edge } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { ShapeProps } from "../../oc/props.js";
import { testRect } from "../helpers/profiles.js";
import { getCurrentScene } from "../../scene-manager.js";

function sceneVolume(): number {
  let volume = 0;
  for (const obj of getCurrentScene().getSceneObjects()) {
    for (const shape of obj.getShapes()) {
      volume += ShapeProps.getProperties(shape.getShape()).volumeMm3;
    }
  }
  return volume;
}

/**
 * Thin profiles are built as a region — outer wire plus reversed inner wire —
 * which only holds when the outer wire runs counter-clockwise. A clockwise
 * closed profile (a projected hole loop, a clockwise hand-drawn rectangle)
 * used to build an inverted ring: booleans against it silently removed
 * nothing. ThinFaceMaker now normalizes the direction.
 */
describe("thin profile direction independence", () => {
  setupOC();

  it("extrudes a clockwise rectangle into a wall with the right volume", () => {
    sketch("xy", () => {
      testRect(-40, 40, { at: [40, 0] });
    });
    const inward = extrude(10).thin(-2) as Extrude;

    render();

    expect(inward.getError()).toBeNull();
    const shapes = inward.getShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0].getType()).toBe('solid');
    expect(ShapeProps.getProperties(shapes[0].getShape()).volumeMm3).toBeCloseTo((40 * 40 - 36 * 36) * 10, 3);
  });

  it("cuts a lid shoulder from a projected, offset rim", () => {
    sketch("xy", () => {
      const c = circle([0, 0], 30);
      coincident(c.center(), origin());
      diameter(c, 30);
    });
    const body = extrude(20) as Extrude;
    shell(-2, body.endFaces());
    const rim = select(edge().onPlane(body.endFaces()).circle(26));
    sketch(body.endFaces(), () => {
      const guide = project(rim).guide();
      // Inner rim r=13 grown to r=14; the 1 mm thin ring back to r=13 sits
      // inside the 2 mm wall, so the cut takes a 3 mm deep shoulder off it.
      offset(1, guide);
    });
    const shoulder = cut(3).thin(-1) as ExtrudeBase;

    render();

    expect(shoulder.getError()).toBeNull();
    const wall = Math.PI * (15 * 15 * 20 - 13 * 13 * 18);
    const removed = Math.PI * (14 * 14 - 13 * 13) * 3;
    expect(sceneVolume()).toBeCloseTo(wall - removed, 2);
  });
});
