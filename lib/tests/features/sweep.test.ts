import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import extrude from "../../core/extrude.js";
import helix from "../../core/helix.js";
import cylinder from "../../core/cylinder.js";
import { circle, rect, vLine, hLine, arc, move, hMove } from "../../core/2d/index.js";
import { Sweep } from "../../features/sweep.js";
import { Extrude } from "../../features/extrude.js";
import { Sketch } from "../../features/2d/sketch.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";

describe("sweep", () => {
  setupOC();

  describe("basic sweep", () => {
    it("should sweep a circle along a straight line path", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should sweep a rect along a straight line path", () => {
      const profile = sketch("xy", () => {
        rect(20, 10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce a solid with positive volume", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const props = ShapeProps.getProperties(s.getShapes()[0].getShape());
      expect(props.volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("sweep with curved path", () => {
    it("should sweep a circle along an arc path", () => {
      const profile = sketch("xy", () => {
        circle(5);
      });

      const path = sketch("xz", () => {
        arc(50, 90);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should sweep along a multi-segment path", () => {
      const profile = sketch("xy", () => {
        circle(4);
      });

      const path = sketch("xz", () => {
        vLine(30);
        hLine(30);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const props = ShapeProps.getProperties(shapes[0].getShape());
      expect(props.volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("sweep with hollow profile", () => {
    it("should sweep two nested circles preserving the hole", () => {
      const profile = sketch("xy", () => {
        circle(20);
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      // The hollow sweep should have less volume than a solid sweep
      const hollowVolume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;

      // A solid circle(20) swept 50 would be pi*20^2*50 ≈ 62832
      const fullCylinderVolume = Math.PI * 20 * 20 * 50;
      expect(hollowVolume).toBeLessThan(fullCylinderVolume * 0.95);
      expect(hollowVolume).toBeGreaterThan(0);
    });
  });

  describe("target selection", () => {
    it("should use the last extrudable when no target is given", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      // When called with explicit target, it should use that
      expect(s.extrudable).toBe(profile);
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should use the given target over the last extrudable", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      sketch("xy", () => {
        rect(100, 50);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      expect(s.extrudable).toBe(profile);
    });
  });

  describe("input consumption", () => {
    it("should remove extrudable shapes", () => {
      const profile = sketch("xy", () => {
        circle(10);
      }) as Sketch;

      const path = sketch("xz", () => {
        vLine(50);
      });

      sweep(path, profile);

      render();

      expect(profile.getShapes()).toHaveLength(0);
    });

    it("should remove path shapes", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      }) as Sketch;

      sweep(path, profile);

      render();

      expect(path.getShapes()).toHaveLength(0);
    });
  });

  describe("scene shape count", () => {
    it("should produce a single shape in the scene", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      sweep(path, profile);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("bounding box", () => {
    it("should have correct dimensions for a straight sweep", () => {
      const profile = sketch("xy", () => {
        circle(10);
      });

      const path = sketch("xz", () => {
        vLine(50);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      // Circle diameter 10 (radius 5) swept 50 units along Z
      expect(bbox.maxX - bbox.minX).toBeCloseTo(10, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(10, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(50, 0);
    });
  });

  describe("startFaces / endFaces / sideFaces", () => {
    it("should expose start and end faces", () => {
      const profile = sketch("xy", () => {
        rect(20, 10);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile) as Sweep;
      const sf = s.startFaces();
      const ef = s.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      const startFaces = sf.getShapes();
      expect(startFaces.length).toBeGreaterThan(0);
      expect(startFaces[0].getType()).toBe("face");

      const endFaces = ef.getShapes();
      expect(endFaces.length).toBeGreaterThan(0);
      expect(endFaces[0].getType()).toBe("face");
    });

    it("should expose side faces", () => {
      const profile = sketch("xy", () => {
        rect(20, 10);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile) as Sweep;
      const sidf = s.sideFaces();
      addToScene(sidf);

      render();

      const sideFaces = sidf.getShapes();
      expect(sideFaces.length).toBeGreaterThan(0);
      for (const f of sideFaces) {
        expect(f.getType()).toBe("face");
      }
    });

    it("should filter side faces by index", () => {
      const profile = sketch("xy", () => {
        rect(20, 10);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile) as Sweep;
      const allSide = s.sideFaces();
      const first = s.sideFaces(0);
      addToScene(allSide);
      addToScene(first);

      render();

      expect(first.getShapes()).toHaveLength(1);
      expect(first.getShapes()[0].isSame(allSide.getShapes()[0])).toBe(true);
    });
  });

  describe("startEdges / endEdges / sideEdges", () => {
    it("should expose start and end edges", () => {
      const profile = sketch("xy", () => {
        rect(20, 10);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile) as Sweep;
      const se = s.startEdges();
      const ee = s.endEdges();
      addToScene(se);
      addToScene(ee);

      render();

      const startEdges = se.getShapes();
      expect(startEdges.length).toBeGreaterThan(0);
      for (const e of startEdges) {
        expect(e.getType()).toBe("edge");
      }

      const endEdges = ee.getShapes();
      expect(endEdges.length).toBeGreaterThan(0);
    });

    it("should expose side edges excluding start/end edges", () => {
      const profile = sketch("xy", () => {
        rect(20, 10);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      const s = sweep(path, profile) as Sweep;
      const side = s.sideEdges();
      const se = s.startEdges();
      const ee = s.endEdges();
      addToScene(side);
      addToScene(se);
      addToScene(ee);

      render();

      const sideEdges = side.getShapes();
      expect(sideEdges.length).toBeGreaterThan(0);

      const startEdges = se.getShapes();
      const endEdges = ee.getShapes();
      for (const s of sideEdges) {
        const inStart = startEdges.some(e => e.isSame(s));
        const inEnd = endEdges.some(e => e.isSame(s));
        expect(inStart).toBe(false);
        expect(inEnd).toBe(false);
      }
    });
  });

  describe("fusion", () => {
    it("should fuse with existing geometry by default", () => {
      sketch("xy", () => {
        rect(30, 30);
      });

      extrude(20);

      const profile = sketch("xy", () => {
        circle(5);
      });

      const path = sketch("xz", () => {
        vLine(40);
      });

      sweep(path, profile);

      const scene = render();

      // Fused result should be a single shape
      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("helix sweep with cone fuse/cut", () => {
    it(".add() with helix on cone face fuses to a single solid", () => {
      sketch("xy", () => { circle(30); });
      const c = extrude(50).draft(10) as Extrude;
      const path = helix(c.sideFaces()).turns(10);
      const profile = sketch("xz", () => {
        move([15, 0]);
        circle(2);
      });
      const s = sweep(path, profile).add() as Sweep;
      render();

      const sShapes = s.getShapes();
      const totalVol = sShapes.reduce(
        (acc, sh) => acc + ShapeProps.getProperties(sh.getShape()).volumeMm3,
        0,
      );
      expect(c.getShapes().length).toBe(0);
      expect(sShapes.length).toBe(1);
      expect(totalVol).toBeGreaterThan(60000);
      expect(totalVol).toBeLessThan(64000);
    });

    it(".remove() with helix on cone face cuts a groove", () => {
      sketch("xy", () => { circle(30); });
      const c = extrude(50).draft(10) as Extrude;
      const path = helix(c.sideFaces()).turns(10);
      const profile = sketch("xz", () => {
        move([15, 0]);
        circle(2);
      });
      const s = sweep(path, profile).remove() as Sweep;
      render();

      const sShapes = s.getShapes();
      const totalVol = sShapes.reduce(
        (acc, sh) => acc + ShapeProps.getProperties(sh.getShape()).volumeMm3,
        0,
      );
      expect(c.getShapes().length).toBe(0);
      expect(sShapes.length).toBe(1);
      expect(totalVol).toBeGreaterThan(56000);
      expect(totalVol).toBeLessThan(62000);
    });
  });

  describe("conical (tapered) helix sweep", () => {
    // A tapered helical spine (endRadius ≠ radius) produces a swept surface
    // that needs many approximation spans; at MakePipeShell's small default
    // segment budget the build silently fails (PipeNotDone). SweepOps raises
    // the budget (MAX_PIPE_SEGMENTS), so these build with the fixed binormal.
    it("sweeps a circle along an outward-tapering helix", () => {
      const path = helix("z").height(100).pitch(10).radius(15).endRadius(25);
      const profile = sketch("left", () => {
        hMove(15);
        circle(2);
      });
      const s = sweep(path, profile) as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      const props = ShapeProps.getProperties(shapes[0].getShape());
      expect(props.volumeMm3).toBeGreaterThan(0);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // End radius 25 + tube radius 2 ⇒ ~54mm across; height 100 ⇒ ~100mm tall.
      expect(bbox.maxX - bbox.minX).toBeGreaterThan(50);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThan(95);
    });

    it("sweeps a circle along an inward-tapering helix", () => {
      const path = helix("z").height(80).pitch(8).radius(25).endRadius(12);
      const profile = sketch("left", () => {
        hMove(25);
        circle(1.5);
      });
      const s = sweep(path, profile) as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
      expect(ShapeProps.getProperties(shapes[0].getShape()).volumeMm3).toBeGreaterThan(0);
    });
  });

  describe("helix sweep tangent to a cylinder (fuzzy boolean)", () => {
    // A helix at the cylinder's own radius makes a swept thread that touches
    // the cylinder tangentially along the contact curves. At zero boolean fuzz
    // OCCT's BOPAlgo silently no-ops (cut removes nothing; fuse returns an empty
    // compound). BooleanOps' small fuzzy value resolves the contact. Volume
    // ≈ a radius-15 / height-50 cylinder = π·225·50 ≈ 35343 mm³.
    const CYL_VOL = Math.PI * 225 * 50;

    it("removes a helical groove from the cylinder surface", () => {
      cylinder(15, 50);
      const path = helix("z").height(50).radius(15).pitch(5).startOffset(-5).endOffset(5);
      const profile = sketch("left", () => { move([15, 0]); circle(3); });
      const s = sweep(path, profile).remove() as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      const vol = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      // A real groove was carved: less than the full cylinder, but most remains.
      expect(vol).toBeGreaterThan(CYL_VOL * 0.8);
      expect(vol).toBeLessThan(CYL_VOL - 100);
    });

    it("fuses a helical thread onto the cylinder surface", () => {
      cylinder(15, 50);
      const path = helix("z").height(50).radius(15).pitch(5).startOffset(-5).endOffset(5);
      const profile = sketch("left", () => { move([15, 0]); circle(3); });
      const s = sweep(path, profile).add() as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      // A thread was added: more than the bare cylinder.
      expect(ShapeProps.getProperties(shapes[0].getShape()).volumeMm3).toBeGreaterThan(CYL_VOL + 100);
    });

    it("removes a groove when the helix has no start/end offset", () => {
      cylinder(15, 50);
      const path = helix("z").height(50).radius(15).pitch(5);
      const profile = sketch("left", () => { move([15, 0]); circle(3); });
      const s = sweep(path, profile).remove() as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      const vol = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      expect(vol).toBeGreaterThan(CYL_VOL * 0.8);
      expect(vol).toBeLessThan(CYL_VOL - 100);
    });
  });
});
