import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { join } from "path";
import getSystemFonts from "get-system-fonts";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import cylinder from "../../core/cylinder.js";
import helix from "../../core/helix.js";
import { arc, circle, hLine, text } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { getBoundingBoxOfShapes } from "../utils.js";
import { Shape } from "../../common/shape.js";
import { Text } from "../../features/2d/text.js";
import { FontRegistry } from "../../io/font-registry.js";

const normFamily = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// The extruded solids produced by an extrude scene object (the real geometry,
// excluding helper shapes like the sketch plane that countShapes would include).
function solidsOf(e: unknown): Shape[] {
  return (e as { getShapes(): Shape[] }).getShapes();
}

describe("text", () => {
  setupOC();

  it("extrudes standalone text on a plane into a solid", () => {
    text("xy", "A").size(20);
    const e = extrude(5);
    render();

    const solids = solidsOf(e);
    expect(solids.length).toBeGreaterThanOrEqual(1);
    const bbox = getBoundingBoxOfShapes(solids);
    expect(bbox.maxX - bbox.minX).toBeGreaterThan(1);  // has width
    expect(bbox.maxY - bbox.minY).toBeGreaterThan(1);  // has height
    // ~5 (mesh bounding box overshoots exact geometry slightly).
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(5, 0);   // extruded depth

    // Orientation: baseline sits at the plane origin (y=0); an "A" (no
    // descender) must rise into +y and run in +x — i.e. upright, not flipped
    // or mirrored.
    expect(bbox.minY).toBeGreaterThan(-1);
    expect(bbox.maxY).toBeGreaterThan(5);
    expect(bbox.minX).toBeGreaterThan(-1);
    expect(bbox.maxX).toBeGreaterThan(5);
  });

  it("renders text inside a sketch", () => {
    sketch("xy", () => {
      text("Hi").size(12);
    });
    const e = extrude(3);
    render();

    const solids = solidsOf(e);
    expect(solids.length).toBeGreaterThanOrEqual(1);
    const bbox = getBoundingBoxOfShapes(solids);
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(3, 0); // ~3 (mesh bbox overshoot)
  });

  it("builds a letter with a counter (hole) such as 'o'", () => {
    // Outer + inner contours must both build; FaceMaker2 drills the counter.
    // We don't assert exact topology (font-dependent) — only a valid solid.
    text("xy", "o").size(20);
    const e = extrude(4);
    render();
    expect(solidsOf(e).length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to a default font when the named font is missing", () => {
    text("xy", "Z").size(20).font("NoSuchFont__XYZ");
    const e = extrude(4);
    render();
    expect(solidsOf(e).length).toBeGreaterThanOrEqual(1);
  });

  it("honours font weight without throwing", () => {
    text("xy", "B").size(20).weight("bold");
    const e = extrude(4);
    render();
    expect(solidsOf(e).length).toBeGreaterThanOrEqual(1);
  });

  it("resolves named system fonts (does not collapse every font to one fallback)", () => {
    const families = FontRegistry.availableFamilies();
    expect(families.length).toBeGreaterThan(0);
    // At least one installed family must resolve to itself. If openSync is
    // mis-called (passing a postscriptName as a variation arg), every lookup
    // throws and collapses to a single fallback font — this guards that.
    const matched = families.some(
      f => normFamily(FontRegistry.resolve({ font: f }).familyName) === normFamily(f),
    );
    expect(matched).toBe(true);
  });

  it("loads a workspace-relative .ttf font file", async () => {
    const files = await (getSystemFonts as any)();
    const src = (files as string[]).find(f => f.toLowerCase().endsWith(".ttf"));
    if (!src) {
      return; // no .ttf available to copy on this machine; skip
    }
    const root = process.env.FLUIDCAD_WORKSPACE_PATH!;
    fs.mkdirSync(join(root, "fonts"), { recursive: true });
    fs.copyFileSync(src, join(root, "fonts", "test.ttf"));

    text("xy", "A").size(20).font("fonts/test.ttf");
    const e = extrude(5);
    render();
    expect(solidsOf(e).length).toBeGreaterThanOrEqual(1);
  });
});

describe("text along a path", () => {
  setupOC();

  it("lays text upright along a straight sketch line", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("Hi", path).size(10) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    // Upright on the line: baseline at y=0 rising into +y, running in +x.
    expect(bbox.minY).toBeGreaterThan(-1);
    expect(bbox.maxY).toBeGreaterThan(4);
    expect(bbox.minX).toBeGreaterThan(-1);
    expect(bbox.maxX).toBeLessThan(50);
    // Planar output in the sketch plane (z = 0); the bbox helper pads by 0.1.
    expect(Math.abs(bbox.minZ)).toBeLessThan(0.2);
    expect(Math.abs(bbox.maxZ)).toBeLessThan(0.2);
  });

  it("extrudes path text into a solid", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("Hi", path).size(10);
    const e = extrude(5, t);
    render();

    const solids = solidsOf(e);
    expect(solids.length).toBeGreaterThanOrEqual(1);
    const bbox = getBoundingBoxOfShapes(solids);
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(5, 0);
  });

  it("keeps every glyph on the ring when following a circle", () => {
    const path = sketch("xy", () => {
      circle(100); // diameter 100 -> radius 50
    });
    const t = text("FLUIDCAD", path).size(8).align("center") as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const shapes = t.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
    // Each outline edge must hug the ring: its center stays within an
    // annulus around radius 50 (giving the glyph height some slack).
    for (const s of shapes) {
      const b = getBoundingBoxOfShapes([s]);
      const r = Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
      expect(r).toBeGreaterThan(38);
      expect(r).toBeLessThan(62);
    }
  });

  it("offsets the baseline away from the path", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("Hi", path).size(10).offset(5) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    expect(bbox.minY).toBeGreaterThan(4);
  });

  it("flips text to the other side of the path", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("Hi", path).size(10).flip() as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    // Mirrored below the line.
    expect(bbox.maxY).toBeLessThan(1);
    expect(bbox.minY).toBeLessThan(-4);
  });

  it("starts at an arc-length distance along the path", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("I", path).size(10).startAt(30) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    expect(bbox.minX).toBeGreaterThan(25);
    expect(bbox.maxX).toBeLessThan(45);
  });

  it("aligns right against the path end", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("Hi", path).size(10).align("right") as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    expect(bbox.maxX).toBeLessThan(101);
    expect(bbox.maxX).toBeGreaterThan(85);
  });

  it("follows a standalone planar primitive and wraps on a closed path", () => {
    // Text much longer than the circumference must wrap, not error.
    const ring = circle("xy", 30); // radius 15, circumference ~94
    const t = text("WRAPPING ALL THE WAY AROUND", ring).size(8) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    expect(bbox.minX).toBeGreaterThan(-35);
    expect(bbox.maxX).toBeLessThan(35);
    expect(bbox.minY).toBeGreaterThan(-35);
    expect(bbox.maxY).toBeLessThan(35);
  });

  it("follows a circular edge selected from a solid", () => {
    cylinder(30, 50);
    const rim = select(edge().circle().onPlane("xy", { offset: 50 }));
    const t = text("RIM", rim).size(6) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const shapes = t.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
    // The fitted path plane is the rim's plane: all glyphs at z = 50
    // (the bbox helper pads by 0.1).
    const bbox = getBoundingBoxOfShapes(shapes);
    expect(bbox.minZ).toBeGreaterThan(49.7);
    expect(bbox.maxZ).toBeLessThan(50.3);
  });

  it("stacks multi-line text perpendicular to the path", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("AB\nCD", path).size(10) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    // Two lines: total height exceeds a single line's cap height.
    expect(bbox.maxY - bbox.minY).toBeGreaterThan(10);
    expect(bbox.minY).toBeLessThan(-4); // second line below the baseline
  });

  it("rejects a non-planar path", () => {
    const h = helix("z").radius(20).pitch(10).turns(2);
    const t = text("Hi", h) as Text;
    render();

    expect(t.getError()).toMatch(/planar/i);
  });

  it("rejects path-only modifiers without a path", () => {
    const t = text("xy", "Hi").offset(3) as Text;
    render();

    expect(t.getError()).toMatch(/offset/i);
  });

  it("sits on the outside of a closed circle by default", () => {
    const ring = circle("xy", 100); // radius 50
    const t = text("OUTSIDE", ring).size(8) as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const radii = t.getShapes().map((s) => {
      const b = getBoundingBoxOfShapes([s]);
      return Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    });
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(mean).toBeGreaterThan(50);
  });

  it("moves closed-path text inside with flip", () => {
    const ring = circle("xy", 100); // radius 50
    const t = text("INSIDE", ring).size(8).flip() as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const radii = t.getShapes().map((s) => {
      const b = getBoundingBoxOfShapes([s]);
      return Math.hypot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    });
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(mean).toBeLessThan(50);
  });

  it("stretches text across the full path", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("AB", path).size(10).align("stretch") as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    expect(bbox.minX).toBeLessThan(12);
    expect(bbox.maxX).toBeGreaterThan(88);
  });

  it("accepts start/end alignment synonyms", () => {
    const path = sketch("xy", () => {
      hLine(100);
    });
    const t = text("Hi", path).size(10).align("end") as Text;
    render();

    expect(t.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t.getShapes());
    expect(bbox.maxX).toBeLessThan(101);
    expect(bbox.maxX).toBeGreaterThan(85);
  });

  it("rejects stretch alignment without a path", () => {
    const t = text("xy", "Hi").align("stretch") as Text;
    render();

    expect(t.getError()).toMatch(/stretch/i);
  });

  it("follows an arc drawn in the same sketch", () => {
    let t: Text;
    sketch("xy", () => {
      const a = arc([0, 0], [100, 0]).center([50, -200]).cw().guide();
      t = text("Marwan", a).size(15) as Text;
    });
    render();

    expect(t!.getError()).toBeFalsy();
    const bbox = getBoundingBoxOfShapes(t!.getShapes());
    // A shallow arc bulging up: text sits along it, above y = 0 won't hold
    // everywhere, but it must stay near the arc band and inside x ∈ [0, 100].
    expect(bbox.minX).toBeGreaterThan(-5);
    expect(bbox.maxX).toBeLessThan(105);
    expect(bbox.maxY).toBeGreaterThan(4);
    // Planar in the sketch plane; the bbox helper pads by 0.1.
    expect(Math.abs(bbox.minZ)).toBeLessThan(0.2);
    expect(Math.abs(bbox.maxZ)).toBeLessThan(0.2);
  });

  it("extrudes in-sketch path text whose guide path stays out of the profile", () => {
    sketch("xy", () => {
      const a = arc([0, 0], [100, 0]).center([50, -200]).cw().guide();
      text("Hi", a).size(12);
    });
    const e = extrude(4);
    render();

    const solids = solidsOf(e);
    expect(solids.length).toBeGreaterThanOrEqual(1);
    const bbox = getBoundingBoxOfShapes(solids);
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(4, 0);
  });

  it("multiple texts can share one path", () => {
    const ring = circle("xy", 100);
    const outside = text("OUTSIDE", ring).size(8) as Text;
    const inside = text("INSIDE", ring).size(8).flip() as Text;
    render();

    expect(outside.getError()).toBeFalsy();
    expect(inside.getError()).toBeFalsy();
  });
});
