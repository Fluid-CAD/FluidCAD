import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import translate from "../../core/translate.js";
import { circle, rect } from "../../core/2d/index.js";
import part from "../../core/part.js";
import { Part } from "../../features/part.js";
import { Extrude } from "../../features/extrude.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Sketch } from "../../features/2d/sketch.js";
import { countShapes } from "../utils.js";

describe("part", () => {
  setupOC();

  it("should execute a part callback immediately", () => {
    part("my-part", () => {
      sketch("xy", () => {
        circle(10);
      });
      extrude(20);
    });

    const scene = getCurrentScene();
    const objects = scene.getAllSceneObjects();

    const parts = objects.filter(o => o instanceof Part);
    expect(parts).toHaveLength(1);
    expect((parts[0] as Part).partName).toBe("my-part");
  });

  it("should produce a solid", () => {
    part("solid-part", () => {
      sketch("xy", () => {
        circle(10);
      });
      extrude(20);
    });

    render();

    const scene = getCurrentScene();
    const objects = scene.getAllSceneObjects();
    const extrudeObj = objects.find(o => o instanceof Extrude) as Extrude;

    expect(extrudeObj).toBeDefined();
    const shapes = extrudeObj.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes[0].getType()).toBe("solid");
  });

  describe("fusion isolation", () => {
    it("should keep two parts as separate solids", () => {
      part("part1", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      part("part2", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const extrudes = objects.filter(o => o instanceof Extrude) as Extrude[];

      expect(extrudes).toHaveLength(2);

      const shapes1 = extrudes[0].getShapes();
      const shapes2 = extrudes[1].getShapes();
      expect(shapes1.length).toBeGreaterThan(0);
      expect(shapes2.length).toBeGreaterThan(0);
    });

    it("should fuse extrudes within the same part", () => {
      part("fusing-part", () => {
        sketch("xy", () => {
          circle([-5, 0], 10);
        });
        extrude(20);

        sketch("xy", () => {
          circle([5, 0], 10);
        });
        extrude(20);
      });

      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const extrudes = objects.filter(o => o instanceof Extrude) as Extrude[];

      expect(extrudes).toHaveLength(2);

      const shapes1 = extrudes[0].getShapes();
      const shapes2 = extrudes[1].getShapes();
      expect(shapes1).toHaveLength(0);
      expect(shapes2.length).toBeGreaterThan(0);
    });
  });

  describe("container structure", () => {
    it("should make sketch a child of the part", () => {
      part("container-test", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude(20);
      });

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

      const shapes = e2.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });

  describe("repeat inside part", () => {
    it("should repeat with explicit objects", () => {
      part("repeat-explicit", () => {
        sketch("xy", () => {
          rect(50);
        });
        const e = extrude().new() as ExtrudeBase;

        repeat("linear", "x", { count: 3, offset: 80 }, e);
      });

      const scene = render();
      expect(countShapes(scene)).toBe(3);
    });

    it("should repeat with default input (last object)", () => {
      part("repeat-default", () => {
        sketch("xy", () => {
          rect(50);
        });
        extrude().new();

        repeat("linear", "x", { count: 3, offset: 80 });
      });

      const scene = render();
      expect(countShapes(scene)).toBe(3);
    });

    it("should not override clone parent-child relationships", () => {
      part("clone-parents", () => {
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

      const scene = render();
      expect(countShapes(scene)).toBe(3);
    });
  });

  describe("pick inside part", () => {
    it("should preserve pick meta shapes on extrude inside a part", () => {
      part("pick-test", () => {
        sketch("xy", () => {
          rect(50);
          circle(20);
        });
        extrude().pick();
      });

      const scene = render();
      const rendered = scene.getRenderedObjects();
      const extrudeRender = rendered.find(r => r.type === 'extrude');

      expect(extrudeRender).toBeDefined();
      const metaShapes = extrudeRender!.sceneShapes.filter(s => s.isMetaShape);
      expect(metaShapes.length).toBeGreaterThan(0);
    });

    it("should preserve pick meta shapes with multiple parts", () => {
      part("pick-part1", () => {
        sketch("xy", () => {
          rect(50);
          circle(20);
        });
        extrude().pick();
      });

      part("pick-part2", () => {
        sketch("xy", () => {
          circle(10);
        });
        extrude();
      });

      const scene = render();
      const rendered = scene.getRenderedObjects();
      const extrudeRenders = rendered.filter(r => r.type === 'extrude');

      const metaShapes = extrudeRenders[0]!.sceneShapes.filter(s => s.isMetaShape);
      expect(metaShapes.length).toBeGreaterThan(0);
    });
  });

  describe("part() as transform target", () => {
    it("should return an ISceneObject (Part instance)", () => {
      const result = part("ret-test", () => {
        sketch("xy", () => { circle(10); });
        extrude(20);
      });

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(Part);
    });

    it("should translate a Part target", () => {
      const p = part("translate-part", () => {
        sketch("xy", () => { rect(20, 20); });
        extrude(10);
      });

      translate(50, 0, 0, p);
      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should translate-copy a Part target", () => {
      const p = part("copy-part", () => {
        sketch("xy", () => { rect(20, 20); });
        extrude(10);
      });

      translate(50, 0, 0, true, p);
      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });

    it("should transform only the targeted Part", () => {
      const p1 = part("multi-a", () => {
        sketch("xy", () => { rect(10, 10); });
        extrude(10);
      });

      part("multi-b", () => {
        sketch("xy", () => { rect(20, 20); });
        extrude(20);
      });

      translate(100, 0, 0, p1);
      const scene = render();

      expect(countShapes(scene)).toBe(2);
    });

    it("should work inline with translate", () => {
      translate(50, 0, 0, part("inline-part", () => {
        sketch("xy", () => { circle(10); });
        extrude(20);
      }));
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

  describe("parameterized parts via closures", () => {
    it("should support parameterization through closures", () => {
      function makePart(radius: number, height: number) {
        return part("opts-part", () => {
          sketch("xy", () => {
            circle(radius);
          });
          extrude(height);
        });
      }

      makePart(15, 30);
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

    it("should create separate parts with different parameters", () => {
      function makePart(name: string, size: number) {
        return part(name, () => {
          sketch("xy", () => {
            circle(size);
          });
          extrude(size);
        });
      }

      makePart("reusable-a", 10);
      makePart("reusable-b", 20);
      render();

      const scene = getCurrentScene();
      const objects = scene.getAllSceneObjects();
      const parts = objects.filter(o => o instanceof Part);
      expect(parts).toHaveLength(2);
    });
  });
});
