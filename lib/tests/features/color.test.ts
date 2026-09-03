import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import { } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Color } from "../../features/color.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { countShapes } from "../utils.js";
import { edge, face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

describe("color", () => {
  setupOC();

  describe("apply color to face", () => {
    it("should apply a color to a selected face", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(face().onPlane("xy", 30));
      const c = color("red") as Color;

      render();

      const shapes = c.getShapes();
      expect(shapes).toHaveLength(1);

      const solid = shapes[0] as Solid;
      expect(solid.hasColors()).toBe(true);
    });

    it("should store the correct color value", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
      const c = color("#ff0000", sel) as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.hasColors()).toBe(true);

      // The color map should have an entry with the specified color
      expect(solid.colorMap.length).toBeGreaterThan(0);
      expect(solid.colorMap[0].color).toBe("#ff0000");
    });
  });

  describe("color with explicit selection", () => {
    it("should color the explicitly passed selection", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const sel = select(face().onPlane("xy")) as SelectSceneObject;
      const c = color("blue", sel) as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.hasColors()).toBe(true);
      expect(solid.colorMap[0].color).toBe("#0000ff");
    });
  });

  describe("color multiple faces", () => {
    it("should color multiple selected faces", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      // Select both top and bottom faces
      select(face().parallelTo("xy"));
      const c = color("#008000") as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.colorMap).toHaveLength(2);
      for (const entry of solid.colorMap) {
        expect(entry.color).toBe("#008000");
      }
    });
  });

  describe("color without a selection", () => {
    it("should color every face in the current context", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const c = color("red") as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      // A box has six faces; all of them should be colored red.
      expect(solid.colorMap).toHaveLength(6);
      for (const entry of solid.colorMap) {
        expect(entry.color).toBe("#ff0000");
      }
    });

    it("should match select(face()) followed by color()", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(face());
      const explicit = color("red") as Color;

      render();

      const explicitSolid = explicit.getShapes()[0] as Solid;

      // Rebuild the same model from scratch, coloring with an implicit
      // (no-selection) call, and assert the colored output is identical.
      getSceneManager().startScene();

      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const implicit = color("red") as Color;

      render();

      const implicitSolid = implicit.getShapes()[0] as Solid;

      expect(implicitSolid.colorMap).toHaveLength(explicitSolid.colorMap.length);
      expect(implicitSolid.colorMap.every(e => e.color === "#ff0000")).toBe(true);
    });
  });

  describe("color after a selection another feature claimed", () => {
    it("should not fall back to a selection passed to another feature", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      // The select belongs to the fillet; a bare color() must not reuse it —
      // the fillet consumes its shapes at build and color would fail with a
      // consumed-geometry error.
      fillet(2, select(edge().verticalTo("xy")));
      const c = color("red") as Color;

      render();

      expect(c.getError()).toBeFalsy();
      const solid = c.getShapes()[0] as Solid;
      // Six box faces plus four fillet faces — every one colored.
      expect(solid.colorMap).toHaveLength(solid.getFaces().length);
      expect(solid.colorMap).toHaveLength(10);
      expect(solid.colorMap.every(e => e.color === "#ff0000")).toBe(true);
    });

    it("should not fall back to a selection wrapped in a lazy accessor", () => {
      let c!: Color;
      part("claimed-through-center", () => {
        sketch("xy", () => {
            testRect(100, 50);
          });
        extrude(30);

        // `select(...).center()` hands the selection to the connector through
        // an anchored vertex; the connector consumes it at build.
        connector("c", select(face().onPlane("xy", 30)).center());
        c = color("red") as Color;
      });

      render();

      expect(c.getError()).toBeFalsy();
      const solid = c.getShapes()[0] as Solid;
      expect(solid.colorMap).toHaveLength(6);
      expect(solid.colorMap.every(e => e.color === "#ff0000")).toBe(true);
    });

    it("should still fall back to a reusable selection another feature used", () => {
      let c!: Color;
      part("reusable-stays-eligible", () => {
        sketch("xy", () => {
            testRect(100, 50);
          });
        extrude(30);

        // A reusable selection keeps its shapes through consumption, so it
        // remains the implicit selection for the bare color() that follows.
        const top = select(face().onPlane("xy", 30)).reusable();
        connector("c", top.center());
        c = color("red") as Color;
      });

      render();

      expect(c.getError()).toBeFalsy();
      const solid = c.getShapes()[0] as Solid;
      expect(solid.colorMap).toHaveLength(1);
      expect(solid.colorMap[0].color).toBe("#ff0000");
    });
  });

  describe("color a whole scene object", () => {
    it("should color every face of the passed object", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);

      const c = color("red", e) as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.colorMap).toHaveLength(6);
      for (const entry of solid.colorMap) {
        expect(entry.color).toBe("#ff0000");
      }
    });

    it("should let a later face color override the object's base color", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      color("steelblue", e);

      select(face().onPlane("xy", 30));
      const c = color("tomato") as Color;

      render();

      const solid = c.getShapes()[0] as Solid;
      expect(solid.colorMap).toHaveLength(6);
      expect(solid.colorMap.filter(entry => entry.color === "#ff6347")).toHaveLength(1);
      expect(solid.colorMap.filter(entry => entry.color === "#4682b4")).toHaveLength(5);
    });

    it("should consume the object's solid rather than duplicate it", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      color("red", e);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
      expect(e.getShapes()).toHaveLength(0);
    });
  });

  describe("color replaces original solid", () => {
    it("should produce a single solid in the scene", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(face().onPlane("xy", 30));
      color("red");

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("color removes selection shapes", () => {
    it("should remove the face selection after coloring", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
      color("red", sel);

      render();

      expect(sel.getShapes()).toHaveLength(0);
    });
  });
});
