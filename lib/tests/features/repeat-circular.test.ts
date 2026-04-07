import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import shell from "../../core/shell.js";
import cut from "../../core/cut.js";
import { polygon, project, offset, move, rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { countShapes } from "../utils.js";
import { Sketch } from "../../features/2d/sketch.js";
import { PlaneFromObject } from "../../features/plane-from-object.js";

describe("repeat circular", () => {
  setupOC();

  it("should create repeated instances around z axis", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 4, angle: 360 }, e);

    const scene = render();
    // Original (1) + 3 repeated = 4
    expect(countShapes(scene)).toBe(4);
  });

  it("should place repeated sketch on the correct plane", () => {
    sketch("top", () => {
      polygon(5, 100);
    });

    const e1 = extrude(100) as ExtrudeBase;

    const s = sketch(e1.sideFaces(), () => {
      project(e1.sideFaces(0));
      offset(-4, true);
    }) as unknown as Sketch;

    repeat("circular", "z", { count: 6, angle: 360 }, s);

    const scene = render();

    // The original sketch plane
    const originalPlane = s.getPlane();

    // Find cloned sketches by looking at all scene objects
    const allObjects = scene.getAllSceneObjects();
    const clonedSketches = allObjects.filter(
      (obj): obj is Sketch => obj instanceof Sketch && obj !== s && obj.getTransform() != null
    );

    expect(clonedSketches.length).toBe(5); // 5 cloned sketches

    for (const clonedSketch of clonedSketches) {
      const clonedPlane = clonedSketch.getPlane();

      // The normal should be perpendicular to z (since original is on a side face)
      // i.e., the z component of the normal should be ~0
      expect(clonedPlane.normal.z).toBeCloseTo(0, 1);

      // The plane origin z should match the original
      expect(clonedPlane.origin.z).toBeCloseTo(originalPlane.origin.z, 0);
    }
  });

  it("should produce distinct plane normals for each repeated sketch", () => {
    sketch("top", () => {
      polygon(5, 100);
    });

    const e1 = extrude(100) as ExtrudeBase;

    const s = sketch(e1.sideFaces(), () => {
      project(e1.sideFaces(0));
      offset(-4, true);
    }) as unknown as Sketch;

    repeat("circular", "z", { count: 6, angle: 360 }, s);

    const scene = render();

    const allObjects = scene.getAllSceneObjects();
    const allSketches = allObjects.filter(
      (obj): obj is Sketch => obj instanceof Sketch && obj.planeObj instanceof PlaneFromObject
    );

    // 1 original + 5 clones = 6 sketches on side faces
    expect(allSketches.length).toBe(6);

    // Each sketch should have a plane normal rotated around Z
    // With count=6 and angle=360, offset = 360/(6-1) = 72° per step
    // Steps 1..5 → 72°, 144°, 216°, 288°, 360° (=0°, overlaps original)
    const normals = allSketches.map(sk => {
      const plane = sk.getPlane();
      return { x: plane.normal.x, y: plane.normal.y };
    });

    const angles = normals
      .map(n => Math.atan2(n.y, n.x) * 180 / Math.PI)
      .sort((a, b) => a - b);

    // Expect 5 distinct angles (original + 4 unique copies; the 5th copy at 360° overlaps)
    const uniqueAngles = [angles[0]];
    for (let i = 1; i < angles.length; i++) {
      if (Math.abs(angles[i] - uniqueAngles[uniqueAngles.length - 1]) > 1) {
        uniqueAngles.push(angles[i]);
      }
    }
    expect(uniqueAngles.length).toBe(5);

    // Check that unique angles are roughly 72° apart
    for (let i = 1; i < uniqueAngles.length; i++) {
      const diff = uniqueAngles[i] - uniqueAngles[i - 1];
      expect(diff).toBeCloseTo(72, 0);
    }
  });

  it("should repeat sketch+cut on face without errors", () => {
    sketch("top", () => {
      polygon(5, 100);
    });

    const e1 = extrude(100) as ExtrudeBase;
    shell(-2, e1.endFaces());

    sketch(e1.sideFaces(), () => {
      project(e1.sideFaces(0));
      offset(-4, true);
    });

    const c = cut(2);

    repeat("circular", "z", { count: 6, angle: 360 }, c);

    const scene = render();

    // Should render without errors
    const errorObjects = scene.getRenderedObjects().filter(ro => ro.hasError);
    expect(errorObjects).toHaveLength(0);
  });

  it("should skip specified indices", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 6, angle: 360, skip: [1, 3] }, e);

    const scene = render();
    // Original (1) + 5 copies - 2 skipped = 4
    expect(countShapes(scene)).toBe(4);
  });
});
