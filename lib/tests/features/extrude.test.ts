import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { ShapeProps } from "../../oc/props.js";
import { Solid } from "../../common/solid.js";
import { Extruder } from "../../features/simple-extruder.js";
import { Extrude } from "../../features/extrude.js";
import { exp } from "three/tsl";
import { Sketch } from "../../features/2d/sketch.js";
import cylinder from "../../core/cylinder.js";
import { Cylinder } from "../../features/cylinder.js";
import { countShapes } from "../utils.js";

describe("extrude", () => {
  setupOC();

  it("should extrude last extrudable by default", () => {
    const s = sketch("xy", () => {
      rect(100, 50);
    });

    const e = extrude(30) as Extrude;;

    expect(e.extrudable).toBe(s);
  });

  it("should extrude given extrudable", () => {
    const s1 = sketch("xy", () => {
      circle();
    });

    sketch("xy", () => {
      rect(100, 50);
    });

    const e = extrude(50, s1) as Extrude;;

    render();

    expect(e.extrudable).toBe(s1);
  });

  it("should remove the extrudable", () => {
    const s = sketch("xy", () => {
      rect(100, 50);
    }) as Sketch;

    extrude();

    render();

    const sketchShapes = s.getShapes();
    expect(sketchShapes).toHaveLength(0);
  });

  it("should fuse intersecting faces by default", () => {
    sketch("xy", () => {
      circle([-25, 0], 50);
      circle([25, 0], 50);
    }) as Sketch;

    const e = extrude() as Extrude;

    render();

    const shapes = e.getShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0].getType()).toBe('solid');
  });

  it("should fuse with existing scene objects by default", () => {
    cylinder(50, 50) as Cylinder;

    sketch("xy", () => {
      move([25, 0]);
      circle(50);
    }) as Sketch;

    extrude() as Extrude;

    const scene = render();

    expect(countShapes(scene)).toBe(1);
  });
});
