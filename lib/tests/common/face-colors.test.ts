// Stage A of plans/color-attributes.md: face colours as author-stamped
// records on the holder of the solid. Nothing in the pipeline reads them
// yet, so these tests drive the store directly through a `PaintActor` — a
// statement that paints the top face of its target when it builds.

import { describe, it, expect, afterEach, vi } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import { registerBuilder } from "../../index.js";
import * as core from "../../core/index.js";
import * as filters from "../../filters/index.js";
import * as constraints from "../../core/constraints/index.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { } from "../../core/2d/index.js";
import { SceneObject, type FaceColorRecord } from "../../common/scene-object.js";
import { FaceColorView } from "../../common/face-color-view.js";
import { Face } from "../../common/face.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { Part } from "../../features/part.js";
import type { PartDefinition } from "../../features/part-definition.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Explorer } from "../../oc/explorer.js";
import { testRect } from "../helpers/profiles.js";

/** The face of `solid` lying highest along z. */
function topFaceOf(solid: Solid): Face {
  return solid.getFaces().reduce((best, f) =>
    f.getBoundingBox().minZ > best.getBoundingBox().minZ ? f : best
  );
}

function bottomFaceOf(solid: Solid): Face {
  return solid.getFaces().reduce((best, f) =>
    f.getBoundingBox().maxZ < best.getBoundingBox().maxZ ? f : best
  );
}

function soleSolidOf(obj: SceneObject): Solid {
  const solids = obj.getShapes().filter((s): s is Solid => s instanceof Solid);
  expect(solids).toHaveLength(1);
  return solids[0];
}

/**
 * A statement standing in for the painter: with a `target`, its build
 * records `color` on the target's top face; without one it is only an
 * author with a scene order. `tag` is what the compare sees — two actors
 * with one tag match, a changed tag rebuilds.
 */
class PaintActor extends SceneObject {
  constructor(
    private readonly tag: string,
    private readonly target: SceneObject | null = null,
    private readonly color: string = "red",
  ) {
    super();
  }

  getType(): string {
    return "paint";
  }

  serialize() {
    return {};
  }

  build(): void {
    if (!this.target) {
      return;
    }
    const solid = soleSolidOf(this.target);
    this.target.recordFaceColor(solid, topFaceOf(solid), this.color, this);
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof PaintActor)) {
      return false;
    }
    return super.compareTo(other) && this.tag === other.tag;
  }
}

function recordsOf(obj: SceneObject): FaceColorRecord[] {
  return obj.getState('faceColors') as FaceColorRecord[];
}

function buildBox(height = 30): Extrude {
  sketch("xy", () => {
    testRect(100, 50);
  });
  return extrude(height) as unknown as Extrude;
}

describe("face colour records", () => {
  setupOC();

  describe("record and read on a holder", () => {
    it("resolves a recorded colour on the face, normalised to #rrggbb", () => {
      const e = buildBox();
      render();
      const actor = new PaintActor("a");
      addToScene(actor);

      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      e.recordFaceColor(solid, top, "red", actor);

      expect(e.faceColorOf(solid, top)).toBe("#ff0000");
      expect(e.faceColorOf(solid, bottomFaceOf(solid))).toBeUndefined();
      expect(recordsOf(e)).toHaveLength(1);
      expect(recordsOf(e)[0]).toMatchObject({ solid, face: top, color: "#ff0000", setBy: actor });
      // The holder's shapes are untouched by a paint.
      expect(e.getShapes()).toEqual([solid]);
    });

    it("normalises hex spellings too, so one colour never reads as two", () => {
      const e = buildBox();
      render();
      const actor = new PaintActor("a");
      addToScene(actor);
      const solid = soleSolidOf(e);

      e.recordFaceColor(solid, topFaceOf(solid), "#FF0000", actor);
      e.recordFaceColor(solid, bottomFaceOf(solid), "#f00", actor);

      expect(e.faceColorOf(solid, topFaceOf(solid))).toBe("#ff0000");
      expect(e.faceColorOf(solid, bottomFaceOf(solid))).toBe("#ff0000");
    });

    it("matches the face by IsSame: either orientation of the face resolves", () => {
      const e = buildBox();
      render();
      const actor = new PaintActor("a");
      addToScene(actor);
      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      e.recordFaceColor(solid, top, "red", actor);

      const reversed = Face.fromTopoDSFace(Explorer.toFace(top.getShape().Reversed()));
      try {
        expect(e.faceColorOf(solid, reversed)).toBe("#ff0000");
      } finally {
        reversed.dispose();
      }
    });

    it("keys records by the solid wrapper: another wrapper of the same body does not match", () => {
      const e = buildBox();
      render();
      const actor = new PaintActor("a");
      addToScene(actor);
      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      e.recordFaceColor(solid, top, "red", actor);

      const alias = solid.copy();
      expect(e.faceColorOf(alias, top)).toBeUndefined();
    });
  });

  describe("container routing", () => {
    it("a record on a part lands on the child holding the solid", () => {
      part("block", () => {
        buildBox(10);
      });
      const scene = render();
      const partObj = scene.getAllSceneObjects().find((o): o is Part => o instanceof Part)!;
      const e = partObj.getChildren().find((c): c is Extrude => c instanceof Extrude)!;
      const actor = new PaintActor("a");
      addToScene(actor);

      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      partObj.recordFaceColor(solid, top, "steelblue", actor);

      expect(recordsOf(partObj)).toHaveLength(0);
      expect(recordsOf(e)).toHaveLength(1);
      expect(e.faceColorOf(solid, top)).toBe("#4682b4");
      // Reads route the same way.
      expect(partObj.faceColorOf(solid, top)).toBe("#4682b4");
    });
  });

  describe("resolution", () => {
    it("the latest author in scope wins; out of scope, the earlier one; none, nothing", () => {
      const e = buildBox();
      render();
      const first = new PaintActor("first");
      const second = new PaintActor("second");
      addToScene(first);
      addToScene(second);
      expect(second.getOrder()).toBeGreaterThan(first.getOrder());

      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      // Written in the opposite order to prove scene order, not write
      // order, decides.
      e.recordFaceColor(solid, top, "tomato", second);
      e.recordFaceColor(solid, top, "steelblue", first);

      expect(e.faceColorOf(solid, top)).toBe("#ff6347");
      expect(e.faceColorOf(solid, top, new Set([first]))).toBe("#4682b4");
      expect(e.faceColorOf(solid, top, new Set([second]))).toBe("#ff6347");
      expect(e.faceColorOf(solid, top, new Set([e]))).toBeUndefined();
      expect(e.faceColorOf(solid, top, new Set())).toBeUndefined();
    });

    it("one author painting a face twice: the later record wins", () => {
      const e = buildBox();
      render();
      const actor = new PaintActor("a");
      addToScene(actor);
      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);

      e.recordFaceColor(solid, top, "red", actor);
      e.recordFaceColor(solid, top, "blue", actor);

      expect(e.faceColorOf(solid, top)).toBe("#0000ff");
    });
  });

  describe("FaceColorView", () => {
    it("answers get/isEmpty/entries for the resolved faces and frees its map on delete", () => {
      const e = buildBox();
      render();
      const first = new PaintActor("first");
      const second = new PaintActor("second");
      addToScene(first);
      addToScene(second);
      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      const bottom = bottomFaceOf(solid);
      e.recordFaceColor(solid, top, "red", first);
      e.recordFaceColor(solid, top, "blue", second);
      e.recordFaceColor(solid, bottom, "green", first);

      const view = e.getFaceColors(solid);
      try {
        expect(view.isEmpty()).toBe(false);
        expect(view.get(top.getShape())).toBe("#0000ff");
        expect(view.get(bottom.getShape())).toBe("#008000");
        const side = solid.getFaces().find(f => f !== top && f !== bottom)!;
        expect(view.get(side.getShape())).toBeUndefined();

        const entries = view.entries();
        expect(entries).toHaveLength(2);
        expect(entries.find(en => en.face === top)).toMatchObject({ color: "#0000ff", setBy: second });
        expect(entries.find(en => en.face === bottom)).toMatchObject({ color: "#008000", setBy: first });
      } finally {
        view.delete();
      }

      expect(view.isEmpty()).toBe(true);
      expect(view.get(top.getShape())).toBeUndefined();
      // A second delete is a no-op, not a double free.
      expect(() => view.delete()).not.toThrow();
    });

    it("an unpainted solid gives an empty view", () => {
      const e = buildBox();
      render();
      const solid = soleSolidOf(e);
      const view = e.getFaceColors(solid);
      try {
        expect(view.isEmpty()).toBe(true);
        expect(view.entries()).toEqual([]);
        expect(view.get(topFaceOf(solid).getShape())).toBeUndefined();
      } finally {
        view.delete();
      }
    });

    it("faceColorOf never leaks the view it builds", () => {
      const e = buildBox();
      render();
      const actor = new PaintActor("a");
      addToScene(actor);
      const solid = soleSolidOf(e);
      e.recordFaceColor(solid, topFaceOf(solid), "red", actor);

      const deleted = vi.spyOn(FaceColorView.prototype, "delete");
      try {
        e.faceColorOf(solid, topFaceOf(solid));
        e.faceColorOf(solid, bottomFaceOf(solid));
        expect(deleted).toHaveBeenCalledTimes(2);
      } finally {
        deleted.mockRestore();
      }
    });
  });

  describe("SceneCompare", () => {
    it("keeps a record whose painter matched, pointed at the painter's new instance", () => {
      const e1 = buildBox();
      addToScene(new PaintActor("a", e1));
      render();
      const previous = getSceneManager().currentScene;
      const solid = soleSolidOf(e1);
      expect(e1.faceColorOf(solid, topFaceOf(solid))).toBe("#ff0000");

      const next = getSceneManager().startScene();
      const e2 = buildBox();
      const painter2 = new PaintActor("a", e2);
      addToScene(painter2);
      SceneCompare.compare(previous, next);

      expect(next.isCached(e2)).toBe(true);
      expect(next.isCached(painter2)).toBe(true);
      expect(e2.getShapes()).toEqual([solid]);
      const records = recordsOf(e2);
      expect(records).toHaveLength(1);
      expect(records[0].setBy).toBe(painter2);
      expect(e2.faceColorOf(solid, topFaceOf(solid))).toBe("#ff0000");
    });

    it("prunes a record whose painter rebuilt; the rebuilt painter records again", () => {
      const e1 = buildBox();
      addToScene(new PaintActor("a", e1));
      render();
      const previous = getSceneManager().currentScene;
      const solid = soleSolidOf(e1);

      const next = getSceneManager().startScene();
      const e2 = buildBox();
      const painter2 = new PaintActor("b", e2, "blue");
      addToScene(painter2);
      SceneCompare.compare(previous, next);

      expect(next.isCached(e2)).toBe(true);
      expect(next.isCached(painter2)).toBe(false);
      expect(recordsOf(e2)).toHaveLength(0);
      expect(e2.faceColorOf(solid, topFaceOf(solid))).toBeUndefined();

      render();
      expect(e2.getShapes()).toEqual([solid]);
      expect(recordsOf(e2)).toHaveLength(1);
      expect(recordsOf(e2)[0].setBy).toBe(painter2);
      expect(e2.faceColorOf(solid, topFaceOf(solid))).toBe("#0000ff");
    });
  });

  describe("foreign-unit rescale", () => {
    const INCH_FILE = "/ws/fixtures/painted-inch-block.fluid.js";
    const IN = 25.4;

    // A 1 in cube whose top face a `paint(e)` statement in the body colours
    // red — the painter is a member of the part, so it builds (and records)
    // before the part is rescaled into the consuming scene's unit.
    const SOURCE = `
      return part('PaintedInchBlock', () => {
        sketch('xy', () => {
          testRect(1, 1);
        });
        const e = extrude(1);
        paint(e);
      });
      //# sourceURL=${INCH_FILE}
    `;

    const paint = registerBuilder((context) => (target: SceneObject) => {
      const actor = new PaintActor("inch", target);
      context.addSceneObject(actor);
      return actor;
    });

    function definePaintedInchBlock(): PartDefinition {
      const globals: Record<string, unknown> = { ...core, ...filters, ...constraints, testRect, paint };
      const names = Object.keys(globals);
      const fn = new Function(...names, `"use strict";\n${SOURCE}`);
      return fn(...names.map(n => globals[n])) as PartDefinition;
    }

    afterEach(() => {
      getSceneManager().projectUnit = "mm";
      getSceneManager().setCurrentFile("");
    });

    it("remaps the record's face through the solid's transform, so it still resolves", () => {
      getSceneManager().projectUnit = "mm";
      const scene = getSceneManager().startAssemblyScene();
      getUnitRegistry().declare(INCH_FILE, "in");
      const inst = insert(definePaintedInchBlock());
      render();

      const partObj = inst.record.part;
      expect(partObj.isForeignUnit()).toBe(true);
      const e = partObj.getChildren().find((c): c is Extrude => c instanceof Extrude)!;
      const painter = partObj.getChildren().find(c => c instanceof PaintActor)!;
      const solid = soleSolidOf(e);
      const top = topFaceOf(solid);
      expect(top.getBoundingBox().minZ).toBeCloseTo(IN, 4);

      const records = recordsOf(e);
      expect(records).toHaveLength(1);
      expect(records[0].solid).toBe(solid);
      expect(records[0].setBy).toBe(painter);
      expect(records[0].face.isReleased()).toBe(false);
      expect(solid.getFaces().some(f => f.isSame(records[0].face))).toBe(true);
      expect(records[0].face.getBoundingBox().minZ).toBeCloseTo(IN, 4);

      expect(e.faceColorOf(solid, top)).toBe("#ff0000");
      expect(e.faceColorOf(solid, top, new Set(scene.getAllSceneObjects()))).toBe("#ff0000");
      expect(e.faceColorOf(solid, bottomFaceOf(solid))).toBeUndefined();
    });
  });
});
