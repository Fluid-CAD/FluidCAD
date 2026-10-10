import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { testRect } from "./helpers/profiles.js";
import { SketchImage } from "../features/2d/sketch-image.js";

// `.image()` is editor metadata on a sketch statement: the render carries the
// resolved record on the sketch row's `object.image` and nowhere else;
// geometry, solving and consumption are untouched.
describe("sketch().image()", () => {
  setupOC();

  const sketchRow = () => render().getRenderedObjects().find(o => o.type === "sketch")!;

  it("carries the picture on the sketch row with defaults filled in", () => {
    sketch("xy", () => { testRect(20, 10); }).image("images/side.png", { width: 120 });
    const row = sketchRow();
    expect(row.object.image).toEqual({
      src: "images/side.png", width: 120, at: [0, 0], angle: 0, opacity: 0.5,
    });
    expect(row.visible).toBe(true);
  });

  it("keeps every option as given", () => {
    sketch("xy", () => { testRect(20, 10); })
      .image("scan.jpg", { width: 80, height: 50, at: [10, -5], angle: 15, opacity: 0.25 });
    expect(sketchRow().object.image).toEqual({
      src: "scan.jpg", width: 80, height: 50, at: [10, -5], angle: 15, opacity: 0.25,
    });
  });

  it("composes with .close() in either order", () => {
    sketch("xy", () => { testRect(20, 10); }).image("a.png", { height: 30 }).close();
    const row = sketchRow();
    expect(row.closed).toBe(true);
    expect(row.object.image.height).toBe(30);
  });

  it("leaves a sketch without the chain bare", () => {
    sketch("xy", () => { testRect(20, 10); });
    expect(sketchRow().object.image).toBeUndefined();
  });

  it("does not change consumption: the sketch still feeds extrude", () => {
    sketch("xy", () => { testRect(20, 10); }).image("a.png", { width: 10 });
    extrude(5);
    const rows = render().getRenderedObjects();
    expect(rows.find(o => o.type === "sketch")!.visible).toBe(false);
    expect(rows.find(o => o.type === "extrude")!.sceneShapes.some(s => s.shapeType === "solid")).toBe(true);
  });

  it("refuses a malformed call at the statement, like any other bad argument", () => {
    // A build-time error would be cleared and lose the geometry; the chain
    // fails where it is written, with the message pointing at the option.
    expect(() => sketch("xy", () => { testRect(20, 10); }).image("a.png", { width: 10, opacity: 2 } as any))
      .toThrow(/opacity must be between 0/);
  });
});

describe("SketchImage.normalize", () => {
  it("refuses a missing path, a missing size, bad numbers and a bad centre", () => {
    expect(() => SketchImage.normalize("", { width: 1 })).toThrow(/image path/);
    expect(() => SketchImage.normalize("a.png", undefined)).toThrow(/options object/);
    expect(() => SketchImage.normalize("a.png", {})).toThrow(/width or a height/);
    expect(() => SketchImage.normalize("a.png", { width: 0 })).toThrow(/width must be a positive number/);
    expect(() => SketchImage.normalize("a.png", { height: -3 })).toThrow(/height must be a positive number/);
    expect(() => SketchImage.normalize("a.png", { width: 1, at: [1] })).toThrow(/at must be/);
    expect(() => SketchImage.normalize("a.png", { width: 1, angle: NaN })).toThrow(/angle must be a number/);
    expect(() => SketchImage.normalize("a.png", { width: 1, opacity: -0.1 })).toThrow(/opacity/);
  });

  it("trims the path and copies the centre", () => {
    const at: [number, number] = [1, 2];
    const spec = SketchImage.normalize("  a.png ", { width: 1, at });
    expect(spec.src).toBe("a.png");
    expect(spec.at).toEqual([1, 2]);
    expect(spec.at).not.toBe(at);
  });
});
