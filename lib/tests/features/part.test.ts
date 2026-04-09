import { describe, it, expect, beforeEach } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene, setCurrentFile } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import translate from "../../core/translate.js";
import rotate from "../../core/rotate.js";
import { circle, rect } from "../../core/2d/index.js";
import part from "../../core/part.js";
import use from "../../core/use.js";
import { Part } from "../../features/part.js";
import { Extrude } from "../../features/extrude.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Sketch } from "../../features/2d/sketch.js";
import { countShapes } from "../utils.js";

describe("part", () => {
  setupOC();

  beforeEach(() => {
    // Simulate direct editing: currentFile matches the source location
    // Since tests don't have .fluid.js stack frames, we set currentFile to empty
    // so that direct execution tests need special handling
    setCurrentFile('');
  });

  describe("use()", () => {
    it("should execute a part handle via use()", () => {
      const handle = part("my-part", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      // Since there's no .fluid.js source frame, the callback won't auto-execute.
      // We need use() to trigger it.
      use(handle);

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();

      // Should have Part, Plane, Sketch, Circle, Extrude
      const parts = objects.filter(o => o instanceof Part);
      expect(parts).toHaveLength(1);
      expect((parts[0] as Part).partName).toBe("my-part");
    });

    it("should produce a solid when used", () => {
      const handle = part("solid-part", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      use(handle);
      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const extrudeObj = objects.find(o => o instanceof Extrude) as Extrude;

      expect(extrudeObj).toBeDefined();
      const shapes = extrudeObj.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("fusion isolation", () => {
    it("should keep two parts as separate solids", () => {
      const handle1 = part("part1", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      const handle2 = part("part2", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      use(handle1);
      use(handle2);
      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const extrudes = objects.filter(o => o instanceof Extrude) as Extrude[];

      expect(extrudes).toHaveLength(2);

      // Each extrude should have its own solid — they should NOT be fused together
      const shapes1 = extrudes[0].getShapes();
      const shapes2 = extrudes[1].getShapes();
      expect(shapes1.length).toBeGreaterThan(0);
      expect(shapes2.length).toBeGreaterThan(0);
    });

    it("should fuse extrudes within the same part", () => {
      const handle = part("fusing-part", () => {
        sketch("xy", () => {
          circle([-5, 0], 10);
        });
        extrude(20);

        sketch("xy", () => {
          circle([5, 0], 10);
        });
        extrude(20);
      });

      use(handle);
      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const extrudes = objects.filter(o => o instanceof Extrude) as Extrude[];

      expect(extrudes).toHaveLength(2);

      // The second extrude should have fused with the first (overlapping circles)
      // So the first extrude's shapes should have been removed (consumed by fusion)
      const shapes1 = extrudes[0].getShapes();
      const shapes2 = extrudes[1].getShapes();
      expect(shapes1).toHaveLength(0);
      expect(shapes2.length).toBeGreaterThan(0);
    });
  });

  describe("container structure", () => {
    it("should make sketch a child of the part", () => {
      const handle = part("container-test", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      use(handle);

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const partObj = objects.find(o => o instanceof Part) as Part;
      const sketchObj = objects.find(o => o instanceof Sketch) as Sketch;

      expect(partObj).toBeDefined();
      expect(sketchObj).toBeDefined();
      expect(sketchObj.getParent()).toBe(partObj);
    });

    it("should set Part as container", () => {
      const p = new Part("test");
      expect(p.isContainer()).toBe(true);
      expect(p.getType()).toBe("part");
    });
  });

  describe("backward compatibility", () => {
    it("should work normally without parts", () => {
      sketch("xy", () => {
        circle(10);
      });
      const e = extrude(20) as Extrude;

      render();

      const shapes = e.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should fuse objects outside parts normally", () => {
      sketch("xy", () => {
        circle([-5, 0], 10);
      });
      extrude(20);

      sketch("xy", () => {
        circle([5, 0], 10);
      });
      const e2 = extrude(20) as Extrude;

      render();

      // Second extrude should fuse with first (overlapping)
      const shapes = e2.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("repeat inside part", () => {
    it("should repeat with explicit objects", () => {
      const handle = part("repeat-explicit", () => {
        sketch("xy", () => {
          rect(50);
        });
        const e = extrude().new() as ExtrudeBase;

        repeat("linear", "x", { count: 3, offset: 80 }, e);
      });
      use(handle);

      const scene = render();
      // Original + 2 clones = 3 shapes
      expect(countShapes(scene)).toBe(3);
    });

    it("should repeat with default input (last object)", () => {
      const handle = part("repeat-default", () => {
        sketch("xy", () => {
          rect(50);
        });
        extrude().new();

        repeat("linear", "x", { count: 3, offset: 80 });
      });
      use(handle);

      const scene = render();
      expect(countShapes(scene)).toBe(3);
    });

    it("should not override clone parent-child relationships", () => {
      // Regression: cloned Sketch children (Rect) must keep Sketch as parent,
      // not be reparented to the Part container
      const handle = part("clone-parents", () => {
        sketch("xy", () => {
          rect(50);
        });
        const e = extrude();

        sketch(e.endFaces(), () => {
          circle(20);
        });
        const c = cut();

        repeat("linear", "x", { count: 3, offset: 80 }, e, c);
      });
      use(handle);

      const scene = render();
      // Should produce 3 complete instances (original + 2 clones)
      expect(countShapes(scene)).toBe(3);
    });
  });

  describe("pick inside part", () => {
    it("should preserve pick meta shapes on extrude inside a part", () => {
      const handle = part("pick-test", () => {
        sketch("xy", () => {
          rect(50);
          circle(20);
        });
        extrude().pick();
      });
      use(handle);

      const scene = render();
      const rendered = scene.getRenderedObjects();
      const extrudeRender = rendered.find(r => r.type === 'extrude');

      expect(extrudeRender).toBeDefined();
      const metaShapes = extrudeRender!.sceneShapes.filter(s => s.isMetaShape);
      expect(metaShapes.length).toBeGreaterThan(0);
    });

    it("should preserve pick meta shapes with multiple parts", () => {
      const handle1 = part("pick-part1", () => {
        sketch("xy", () => {
          rect(50);
          circle(20);
        });
        extrude().pick();
      });

      const handle2 = part("pick-part2", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude();
      });

      use(handle1);
      use(handle2);

      const scene = render();
      const rendered = scene.getRenderedObjects();
      const extrudeRenders = rendered.filter(r => r.type === 'extrude');

      // First extrude (pick) should still have meta shapes
      const metaShapes = extrudeRenders[0]!.sceneShapes.filter(s => s.isMetaShape);
      expect(metaShapes.length).toBeGreaterThan(0);
    });
  });

  describe("use() as transform target", () => {
    it("should return an ISceneObject (Part instance)", () => {
      const handle = part("ret-test", () => {
        sketch("xy", () => { circle(10); });
        extrude(20);
      });

      const result = use(handle);
      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Part);
    });

    it("should translate a Part target", () => {
      const handle = part("translate-part", () => {
        sketch("xy", () => { rect(20, 20); });
        extrude(10);
      });

      const p = use(handle);
      translate(50, 0, 0, p);
      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should translate-copy a Part target", () => {
      const handle = part("copy-part", () => {
        sketch("xy", () => { rect(20, 20); });
        extrude(10);
      });

      const p = use(handle);
      translate(50, 0, 0, true, p);
      const scene = render();

      // Original + copy = 2 shapes
      expect(countShapes(scene)).toBe(2);
    });

    it("should transform only the targeted Part", () => {
      const handle = part<{ size: number }>("multi", (options) => {
        sketch("xy", () => { rect(options.size, options.size); });
        extrude(options.size);
      });

      const p1 = use(handle, { size: 10 });
      const p2 = use(handle, { size: 20 });
      translate(100, 0, 0, p1);
      const scene = render();

      // Both parts should still produce shapes (2 total)
      expect(countShapes(scene)).toBe(2);
    });

    it("should work inline with translate", () => {
      const handle = part("inline-part", () => {
        sketch("xy", () => { circle(10); });
        extrude(20);
      });

      translate(50, 0, 0, use(handle));
      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("Part visibility", () => {
    it("should always be visible", () => {
      const p = new Part("test");
      expect(p.isAlwaysVisible()).toBe(true);
    });
  });

  describe("options", () => {
    it("should pass options from use() to the part callback", () => {
      const handle = part<{ radius: number; height: number }>("opts-part", (options) => {
        sketch("xy", () => {
          circle(options.radius);
        });
        extrude(options.height);
      });

      use(handle, { radius: 15, height: 30 });
      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const parts = objects.filter(o => o instanceof Part);
      expect(parts).toHaveLength(1);
      expect((parts[0] as Part).partName).toBe("opts-part");

      const extrudeObj = objects.find(o => o instanceof Extrude) as Extrude;
      expect(extrudeObj).toBeDefined();
      const shapes = extrudeObj.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });

    it("should allow reusing a part with different options", () => {
      const handle = part<{ size: number }>("reusable", (options) => {
        sketch("xy", () => {
          circle(options.size);
        });
        extrude(options.size);
      });

      use(handle, { size: 10 });
      use(handle, { size: 20 });
      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const parts = objects.filter(o => o instanceof Part);
      expect(parts).toHaveLength(2);
    });
  });

  describe("PartHandle", () => {
    it("should have correct properties", () => {
      const handle = part("test-handle", () => {});
      expect(handle.__fluidcad_part).toBe(true);
      expect(handle.name).toBe("test-handle");
      expect(handle._callback).toBeInstanceOf(Function);
    });

    it("should throw when use() is given invalid input", () => {
      expect(() => use(null as any)).toThrow("use() expects a PartHandle");
      expect(() => use({} as any)).toThrow("use() expects a PartHandle");
    });
  });
});
