import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { image } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";
import { SketchImage, SketchImageStatement } from "../features/2d/sketch-image.js";

// `image()` is a sketch-body statement with no geometry: its own row (a
// child of the sketch) carries the resolved record and the sketch plane;
// geometry, solving and consumption are untouched.
describe("image() in a sketch", () => {
  setupOC();

  const rows = () => render().getRenderedObjects();
  const imageRow = () => rows().find(o => o.type === "image")!;

  it("is a child row of its sketch carrying the picture with defaults filled in, and the plane", () => {
    sketch("xy", () => {
      image("images/side.png", { width: 120 });
      testRect(20, 10);
    });
    const all = rows();
    const sketchRow = all.find(o => o.type === "sketch")!;
    const row = all.find(o => o.type === "image")!;
    expect(row.parentId).toBe(sketchRow.id);
    expect(row.object.image).toEqual({
      src: "images/side.png", width: 120, at: [0, 0], angle: 0, opacity: 0.5,
    });
    expect(row.object.plane).toEqual(sketchRow.object.plane);
    expect(row.sceneShapes).toEqual([]);
  });

  it("keeps every option as given", () => {
    sketch("xy", () => {
      image("scan.jpg", { width: 80, height: 50, at: [10, -5], angle: 15, opacity: 0.25 });
    });
    expect(imageRow().object.image).toEqual({
      src: "scan.jpg", width: 80, height: 50, at: [10, -5], angle: 15, opacity: 0.25,
    });
  });

  it("allows more than one picture per sketch", () => {
    sketch("xy", () => {
      image("a.png", { width: 10 });
      image("b.png", { height: 20, at: [30, 0] });
    });
    expect(rows().filter(o => o.type === "image").map(o => o.object.image.src)).toEqual(["a.png", "b.png"]);
  });

  it("does not change consumption: the sketch still feeds extrude", () => {
    sketch("xy", () => {
      image("a.png", { width: 10 });
      testRect(20, 10);
    });
    extrude(5);
    const all = rows();
    expect(all.find(o => o.type === "sketch")!.visible).toBe(false);
    expect(all.find(o => o.type === "extrude")!.sceneShapes.some(s => s.shapeType === "solid")).toBe(true);
  });

  it("reports a malformed call as its own build error and leaves the sketch building", () => {
    let statement!: SketchImageStatement;
    sketch("xy", () => {
      statement = image("a.png", { width: 10, opacity: 2 }) as unknown as SketchImageStatement;
      testRect(20, 10);
    });
    extrude(5);
    const all = rows();
    expect(statement.getError()).toMatch(/opacity must be between 0/);
    expect(all.find(o => o.type === "image")!.object.image).toBeUndefined();
    expect(all.find(o => o.type === "extrude")!.sceneShapes.some(s => s.shapeType === "solid")).toBe(true);
  });

  it("refuses a call outside a sketch body", () => {
    const statement = image("a.png", { width: 10 }) as unknown as SketchImageStatement;
    render();
    expect(statement.getError()).toMatch(/inside a sketch/);
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
