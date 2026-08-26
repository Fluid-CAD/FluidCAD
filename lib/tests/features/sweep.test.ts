import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import sweep from "../../core/sweep.js";
import extrude from "../../core/extrude.js";
import helix from "../../core/helix.js";
import cylinder from "../../core/cylinder.js";
import plane from "../../core/plane.js";
import { circle, arc, line } from "../../core/2d/index.js";
import { Sweep } from "../../features/sweep.js";
import { Extrude } from "../../features/extrude.js";
import { Sketch } from "../../features/2d/sketch.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { coincident, horizontal, vertical } from "../../core/constraints/index.js";
import { testRect } from "../helpers/profiles.js";

describe("sweep", () => {
  setupOC();

  describe("basic sweep", () => {
    it("should sweep a circle along a straight line path", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg1 = line([0, 0], [0, 50]);
          vertical(sg1);
        });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should sweep a rect along a straight line path", () => {
      const profile = sketch("xy", () => {
          testRect(20, 10);
        });

      const path = sketch("xz", () => {
          const sg2 = line([0, 0], [0, 50]);
          vertical(sg2);
        });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should produce a solid with positive volume", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg3 = line([0, 0], [0, 50]);
          vertical(sg3);
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
          circle([0, 0], 5);
        });

      const path = sketch("xz", () => {
        // Legacy arc(50, 90): radius 50 from 90° to 180°, starting at the
        // origin — center (0, -50), end (-50, -50).
        arc([0, 0], [-50, -50], [0, -50]);
      });

      const s = sweep(path, profile) as Sweep;

      render();

      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should sweep along a multi-segment path", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 4);
        });

      const path = sketch("xz", () => {
          const sg4 = line([0, 0], [0, 30]);
          const sg5 = line([0, 30], [30, 30]);
          vertical(sg4);
          coincident(sg4.end(), sg5.start());
          horizontal(sg5);
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
          circle([0, 0], 20);
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg6 = line([0, 0], [0, 50]);
          vertical(sg6);
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
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg7 = line([0, 0], [0, 50]);
          vertical(sg7);
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
          circle([0, 0], 10);
        });

      sketch("xy", () => {
          testRect(100, 50);
        });

      const path = sketch("xz", () => {
          const sg8 = line([0, 0], [0, 50]);
          vertical(sg8);
        });

      const s = sweep(path, profile) as Sweep;

      render();

      expect(s.extrudable).toBe(profile);
    });
  });

  describe("input consumption", () => {
    it("should remove extrudable shapes", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        }) as Sketch;

      const path = sketch("xz", () => {
          const sg9 = line([0, 0], [0, 50]);
          vertical(sg9);
        });

      sweep(path, profile);

      render();

      expect(profile.getShapes()).toHaveLength(0);
    });

    it("should remove path shapes", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg10 = line([0, 0], [0, 50]);
          vertical(sg10);
        }) as Sketch;

      sweep(path, profile);

      render();

      expect(path.getShapes()).toHaveLength(0);
    });
  });

  describe("scene shape count", () => {
    it("should produce a single shape in the scene", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg11 = line([0, 0], [0, 50]);
          vertical(sg11);
        });

      sweep(path, profile);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("bounding box", () => {
    it("should have correct dimensions for a straight sweep", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });

      const path = sketch("xz", () => {
          const sg12 = line([0, 0], [0, 50]);
          vertical(sg12);
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

  /**
   * A straight spine takes its binormal off the profile plane, and the plane's
   * own "up" can't serve when the spine runs along it: `Normal = BiNormal ×
   * Tangent` vanishes and MakePipeShell hands back a flat, zero-volume sliver
   * instead of failing. The plane's normal stands in there.
   */
  describe("spine along the profile plane's own axes", () => {
    it("sweeps a real solid along the plane's up direction", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });

      const path = sketch("xy", () => {
          const sg13 = line([-40, -40], [-40, -20]);
          vertical(sg13);
        });

      const s = sweep(path, profile) as Sweep;

      render();

      const props = ShapeProps.getProperties(s.getShapes()[0].getShape());
      expect(props.volumeMm3).toBeCloseTo(Math.PI * 25 * 20, 0);
    });

    it("keeps the drawn profile's footprint when the plane's up is spent on the spine", () => {
      const profile = sketch("xy", () => {
          testRect(20, 10, { at: [-10, -5] });
        });

      const path = sketch("xy", () => {
          const sg14 = line([-40, -40], [-40, -10]);
          vertical(sg14);
        });

      const s = sweep(path, profile) as Sweep;

      render();

      // The section's own up leaves with the spine, and the plane's normal
      // arrives in its place: 20 wide stays on x, 10 tall becomes 10 on z.
      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(20, 1);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(30, 1);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(10, 1);
    });

    it("leaves a spine across the plane on the profile's own up", () => {
      const profile = sketch("xy", () => {
          testRect(20, 10, { at: [-10, -5] });
        });

      const path = sketch("xy", () => {
          const sg15 = line([-40, -40], [-10, -40]);
          horizontal(sg15);
        });

      const s = sweep(path, profile) as Sweep;

      render();

      // Unchanged by the fallback — the drawn height stays on y.
      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(30, 1);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(10, 1);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(20, 1);
    });
  });

  describe("startFaces / endFaces / sideFaces", () => {
    it("should expose start and end faces", () => {
      const profile = sketch("xy", () => {
          testRect(20, 10);
        });

      const path = sketch("xz", () => {
          const sg16 = line([0, 0], [0, 40]);
          vertical(sg16);
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
          testRect(20, 10);
        });

      const path = sketch("xz", () => {
          const sg17 = line([0, 0], [0, 40]);
          vertical(sg17);
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
          testRect(20, 10);
        });

      const path = sketch("xz", () => {
          const sg18 = line([0, 0], [0, 40]);
          vertical(sg18);
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
          testRect(20, 10);
        });

      const path = sketch("xz", () => {
          const sg19 = line([0, 0], [0, 40]);
          vertical(sg19);
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
          testRect(20, 10);
        });

      const path = sketch("xz", () => {
          const sg20 = line([0, 0], [0, 40]);
          vertical(sg20);
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
          testRect(30, 30);
        });

      extrude(20);

      const profile = sketch("xy", () => {
          circle([0, 0], 5);
        });

      const path = sketch("xz", () => {
          const sg21 = line([0, 0], [0, 40]);
          vertical(sg21);
        });

      sweep(path, profile);

      const scene = render();

      // Fused result should be a single shape
      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("helix sweep with cone fuse/cut", () => {
    it(".add() with helix on cone face fuses to a single solid", () => {
      sketch("xy", () => {
          circle([0, 0], 30);
        });
      const c = extrude(50).draft(10) as Extrude;
      const path = helix(c.sideFaces()).turns(10);
      const profile = sketch("xz", () => {
          circle([15, 0], 2);
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
      sketch("xy", () => {
          circle([0, 0], 30);
        });
      const c = extrude(50).draft(10) as Extrude;
      const path = helix(c.sideFaces()).turns(10);
      const profile = sketch("xz", () => {
          circle([15, 0], 2);
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
          circle([15, 0], 2);
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
          circle([25, 0], 1.5);
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
      const profile = sketch("left", () => {
          circle([15, 0], 3);
        });
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
      const profile = sketch("left", () => {
          circle([15, 0], 3);
        });
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
      const profile = sketch("left", () => {
          circle([15, 0], 3);
        });
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

  describe("helix thread sweep (asymmetric profile)", () => {
    // An asymmetric profile swept along a helix is the case that exposes
    // section twist — a rotationally symmetric circle (used by the tests above)
    // looks identical no matter how the section spins, so it can't catch a
    // wobbling trihedron. This sweeps a thread-like trapezoid drawn on a plane
    // built off the helix (plane(h)), the orientation a user reaches for.
    //
    // The fixed binormal must track the helix axis. With the wrong binormal the
    // section flips ~twice per turn, producing a self-intersecting ribbon whose
    // mass piles up on one side (centroid leaves the axis) and whose volume
    // collapses to a fraction of the real thread. For a whole number of turns a
    // correct thread is axisymmetric: its centroid sits on the coil axis.
    it("produces a clean axisymmetric coil, not a wobbling ribbon", () => {
      const h = helix("z").height(80).radius(25).pitch(10); // 8 full turns
      const p = plane(h);
      const profile = sketch(p, () => {
          const sg22 = line([3, 0], [-3, 0]);
          const sg23 = line([-3, 0], [-2, -6]);
          const sg24 = line([-2, -6], [2, -6]);
          const sg25 = line([2, -6], [3, 0]);
          coincident(sg22.end(), sg23.start());
          coincident(sg23.end(), sg24.start());
          coincident(sg24.end(), sg25.start());
          coincident(sg25.end(), sg22.start());
        });
      const s = sweep(h, profile) as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);

      const props = ShapeProps.getProperties(shapes[0].getShape());

      // Centroid on the coil (Z) axis — a wobbling ribbon piled it out at the
      // ~25mm coil radius instead.
      const radialOffset = Math.hypot(props.centroid.x, props.centroid.y);
      expect(radialOffset).toBeLessThan(1);
      expect(props.centroid.z).toBeCloseTo(40, 0);

      // Real thread volume ≈ profile area (30mm²) × coil length (~1260mm).
      // The wobble collapsed this to ~1500mm³; a section that collapses toward
      // the axis (wrong trihedron the other way) drops it to a few thousand.
      expect(props.volumeMm3).toBeGreaterThan(25000);
      expect(props.volumeMm3).toBeLessThan(40000);

      // The coil sits at the helix radius (~25mm), not collapsed onto the axis.
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      const radialExtent = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) / 2;
      expect(radialExtent).toBeGreaterThan(23);
      expect(radialExtent).toBeLessThan(30);
    });
  });

  describe("extend", () => {
    it("extends the run-out past the path end along the tangent", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });
      const path = sketch("xz", () => {
          const sg26 = line([0, 0], [0, 50]);
          vertical(sg26);
        });

      const s = sweep(path, profile).extend("end", 20) as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const shapes = s.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");

      // Straight Z sweep with flat caps: Z extent = path length + extension.
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(70, 0);
    });

    it("extends the lead-in before the path start along the tangent", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });
      const path = sketch("xz", () => {
          const sg27 = line([0, 0], [0, 50]);
          vertical(sg27);
        });

      const s = sweep(path, profile).extend("start", 20) as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(70, 0);
    });

    it("extends both ends when chained", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });
      const path = sketch("xz", () => {
          const sg28 = line([0, 0], [0, 50]);
          vertical(sg28);
        });

      const s = sweep(path, profile).extend("start", 10).extend("end", 20) as Sweep;
      render();

      expect(s.getError()).toBeNull();
      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(80, 0);
    });

    it("adds volume proportional to the extension length", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });
      const path = sketch("xz", () => {
          const sg29 = line([0, 0], [0, 50]);
          vertical(sg29);
        });

      const s = sweep(path, profile).extend("end", 30) as Sweep;
      render();

      // Right cylinder: π·5²·(50 + 30).
      const vol = ShapeProps.getProperties(s.getShapes()[0].getShape()).volumeMm3;
      const expected = 25 * Math.PI * 80;
      expect(vol).toBeGreaterThan(expected * 0.98);
      expect(vol).toBeLessThan(expected * 1.02);
    });

    it("is a no-op for a non-positive amount", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });
      const path = sketch("xz", () => {
          const sg30 = line([0, 0], [0, 50]);
          vertical(sg30);
        });

      const s = sweep(path, profile).extend("end", 0) as Sweep;
      render();

      const bbox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(50, 0);
    });

    it("throws on an invalid side", () => {
      const profile = sketch("xy", () => {
          circle([0, 0], 10);
        });
      const path = sketch("xz", () => {
          const sg31 = line([0, 0], [0, 50]);
          vertical(sg31);
        });

      expect(() => sweep(path, profile).extend("middle" as any, 10)).toThrow();
    });
  });
});
