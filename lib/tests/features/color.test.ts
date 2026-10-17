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
import { Fillet } from "../../features/fillet.js";
import { SelectSceneObject } from "../../features/select.js";
import { SceneObject } from "../../common/scene-object.js";
import { Scene } from "../../rendering/scene.js";
import { colorOf, countShapes, faceColorsOf } from "../utils.js";
import { edge, face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

/** The one body `holder` holds — the canvas a paint writes its records on. */
function bodyOf(holder: SceneObject): Solid {
  const shapes = holder.getShapes();
  expect(shapes).toHaveLength(1);
  return shapes[0] as Solid;
}

/** What the full render drew for `obj`. */
function renderedShapesOf(scene: Scene, obj: SceneObject) {
  const row = scene.getRenderedObject(obj);
  expect(row).toBeDefined();
  return row!.sceneShapes;
}

describe("color", () => {
  setupOC();

  describe("apply color to face", () => {
    it("should record the colour on the extrude and hold nothing itself", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      select(face().onPlane("xy", 30));
      const c = color("red") as Color;

      const scene = render();

      expect(c.getError()).toBeFalsy();
      expect(c.getShapes()).toHaveLength(0);
      expect(renderedShapesOf(scene, c)).toHaveLength(0);

      const solid = bodyOf(e);
      expect(faceColorsOf(scene, solid).size).toBe(1);
      expect(countShapes(scene)).toBe(1);
    });

    it("should store the correct color value", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
      color("#ff0000", sel);

      const scene = render();

      const colors = faceColorsOf(scene, bodyOf(e));
      expect(colors.size).toBe(1);
      expect([...colors.values()][0]).toBe("#ff0000");
    });
  });

  describe("color with explicit selection", () => {
    it("should color the explicitly passed selection", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      const sel = select(face().onPlane("xy")) as SelectSceneObject;
      color("blue", sel);

      const scene = render();

      const colors = faceColorsOf(scene, bodyOf(e));
      expect(colors.size).toBe(1);
      expect([...colors.values()][0]).toBe("#0000ff");
    });

    it("should keep the selection readable while hiding it from the render", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;
      color("red", sel);

      const scene = render();

      // Scope-less: a later feature still gets the face. Scoped (the
      // render): the highlight is gone from the paint on.
      expect(sel.getShapes()).toHaveLength(1);
      expect(renderedShapesOf(scene, sel)).toHaveLength(0);
      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("color multiple faces", () => {
    it("should color multiple selected faces", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      // Select both top and bottom faces
      select(face().parallelTo("xy"));
      color("#008000");

      const scene = render();

      const colors = faceColorsOf(scene, bodyOf(e));
      expect(colors.size).toBe(2);
      for (const value of colors.values()) {
        expect(value).toBe("#008000");
      }
    });
  });

  describe("color without a selection", () => {
    it("should color every face in the current context", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      color("red");

      const scene = render();

      // A box has six faces; all of them should be colored red.
      const colors = faceColorsOf(scene, bodyOf(e));
      expect(colors.size).toBe(6);
      for (const value of colors.values()) {
        expect(value).toBe("#ff0000");
      }
    });

    it("should match select(face()) followed by color()", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const explicitExtrude = extrude(30) as Extrude;

      select(face());
      color("red");

      const explicitScene = render();
      const explicitColors = faceColorsOf(explicitScene, bodyOf(explicitExtrude));

      // Rebuild the same model from scratch, coloring with an implicit
      // (no-selection) call, and assert the colored output is identical.
      getSceneManager().startScene();

      sketch("xy", () => {
          testRect(100, 50);
        });
      const implicitExtrude = extrude(30) as Extrude;

      color("red");

      const implicitScene = render();
      const implicitColors = faceColorsOf(implicitScene, bodyOf(implicitExtrude));

      expect(implicitColors.size).toBe(explicitColors.size);
      expect([...implicitColors.values()].every(value => value === "#ff0000")).toBe(true);
    });

    it("should paint nothing, without an error, when nothing is held yet", () => {
      const c = color("red") as Color;
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      const scene = render();

      expect(c.getError()).toBeFalsy();
      expect(faceColorsOf(scene, bodyOf(e)).size).toBe(0);
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
      const f = fillet(2, select(edge().verticalTo("xy"))) as Fillet;
      const c = color("red") as Color;

      const scene = render();

      expect(c.getError()).toBeFalsy();
      const solid = bodyOf(f);
      // Six box faces plus four fillet faces — every one colored.
      const colors = faceColorsOf(scene, solid);
      expect(colors.size).toBe(solid.getFaces().length);
      expect(colors.size).toBe(10);
      expect([...colors.values()].every(value => value === "#ff0000")).toBe(true);
    });

    it("should not fall back to a selection wrapped in a lazy accessor", () => {
      let c!: Color;
      let e!: Extrude;
      part("claimed-through-center", () => {
        sketch("xy", () => {
            testRect(100, 50);
          });
        e = extrude(30) as Extrude;

        // `select(...).center()` hands the selection to the connector through
        // an anchored vertex; the connector consumes it at build.
        connector("c", select(face().onPlane("xy", 30)).center());
        c = color("red") as Color;
      });

      const scene = render();

      expect(c.getError()).toBeFalsy();
      const colors = faceColorsOf(scene, bodyOf(e));
      expect(colors.size).toBe(6);
      expect([...colors.values()].every(value => value === "#ff0000")).toBe(true);
    });

  });

  describe("color a whole scene object", () => {
    it("should color every face of the passed object", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      const c = color("red", e) as Color;

      const scene = render();

      expect(c.getError()).toBeFalsy();
      const colors = faceColorsOf(scene, bodyOf(e));
      expect(colors.size).toBe(6);
      for (const value of colors.values()) {
        expect(value).toBe("#ff0000");
      }
    });

    it("should let a later face color override the object's base color", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      color("steelblue", e);

      select(face().onPlane("xy", 30));
      color("tomato");

      const scene = render();

      const solid = bodyOf(e);
      const top = solid.getFaces().filter(f => f.center().z === 30);
      expect(top).toHaveLength(1);
      expect(colorOf(scene, solid, top[0])).toBe("#ff6347");
      const others = solid.getFaces().filter(f => f !== top[0]);
      expect(others).toHaveLength(5);
      for (const other of others) {
        expect(colorOf(scene, solid, other)).toBe("#4682b4");
      }
    });

    it("should leave the object's solid where it is, shown as before", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      const c = color("red", e) as Color;

      const scene = render();

      expect(countShapes(scene)).toBe(1);
      expect(e.getShapes()).toHaveLength(1);
      expect(renderedShapesOf(scene, e)).toHaveLength(1);
      expect(c.getShapes()).toHaveLength(0);
      expect(e.getRemovedShapes()).toEqual([]);
    });
  });

  describe("color keeps the scene's shapes", () => {
    it("should leave a single solid in the scene", () => {
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
});
