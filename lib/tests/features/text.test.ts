import { describe, it, expect } from "vitest";
import * as fs from "fs";
import { join } from "path";
import getSystemFonts from "get-system-fonts";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { text } from "../../core/2d/index.js";
import { getBoundingBoxOfShapes } from "../utils.js";
import { Shape } from "../../common/shape.js";
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
