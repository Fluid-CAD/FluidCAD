import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import wrap from "../../core/wrap.js";
import cylinder from "../../core/cylinder.js";
import extrude from "../../core/extrude.js";
import subtract from "../../core/subtract.js";
import select from "../../core/select.js";
import plane from "../../core/plane.js";
import { circle, rect, text, vMove } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Wrap } from "../../features/wrap.js";
import { Face } from "../../common/face.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeProps } from "../../oc/props.js";

// Extruded circle(50) (diameter) → cylinder R=25, z ∈ [0, 80]. Its lateral
// face carries a reverse-parameterized surface (axis -z, flag REVERSED) —
// wrap must still emboss away from the material.
const BASE_VOLUME = Math.PI * 25 * 25 * 80;
// Developed rect(20, 10) pad, thickness 1 outward: (s/R)/2 · ((R+t)² - R²) · h
const PAD_OUT = ((20 / 25) / 2) * (26 * 26 - 25 * 25) * 10;
// Same pocket cut 1 deep into the surface
const PAD_IN = ((20 / 25) / 2) * (25 * 25 - 24 * 24) * 10;

function extrudedCylinder() {
  sketch("top", () => {
    circle(50);
  });
  extrude(80);
}

function rectSketch() {
  return sketch(plane("front", 30), () => {
    vMove(20);
    rect(20, 10);
  });
}

function volumeOf(obj: SceneObject): number {
  return obj.getShapes().reduce(
    (sum, shape) => sum + ShapeProps.getProperties(shape.getShape()).volumeMm3, 0);
}

function endFaceRadialDistances(w: SceneObject): number[] {
  return ((w.getState("end-faces") as Face[]) || []).map(fc => {
    const c = ShapeProps.getProperties(fc.getShape()).centroid;
    return Math.round(Math.hypot(c.x, c.y) * 10) / 10;
  });
}

describe("wrap on an extruded (reverse-parameterized) cylinder", () => {
  setupOC();

  it("embosses a rect pad outward", () => {
    extrudedCylinder();
    const s = rectSketch();
    const f = select(face().cylinder());
    const w = wrap(1, s, f) as Wrap;
    const obj = w as unknown as SceneObject;
    render();

    expect(w.getError()).toBeNull();
    expect(volumeOf(obj)).toBeCloseTo(BASE_VOLUME + PAD_OUT, 0);
  });

  it("places a standalone pad outside the surface", () => {
    extrudedCylinder();
    const s = rectSketch();
    const f = select(face().cylinder());
    const w = wrap(1, s, f).new() as Wrap;
    const obj = w as unknown as SceneObject;
    render();

    expect(w.getError()).toBeNull();
    // 204 only fits the outward shell (25..26); the inward one would be 196
    expect(volumeOf(obj)).toBeCloseTo(PAD_OUT, 0);
  });

  it("engraves a pocket into the surface", () => {
    extrudedCylinder();
    const s = rectSketch();
    const f = select(face().cylinder());
    const w = wrap(1, s, f).remove() as Wrap;
    render();

    expect(w.getError()).toBeNull();
    const total = volumeOf(w as unknown as SceneObject);
    expect(total).toBeCloseTo(BASE_VOLUME - PAD_IN, 0);
  });

  it("embosses text decals outward (user repro)", () => {
    extrudedCylinder();
    const s = sketch(plane("front", 30), () => {
      vMove(20);
      text("hello world").align("center");
    });
    const f = select(face().cylinder());
    const w = wrap(1, s, f).new() as Wrap;
    const obj = w as unknown as SceneObject;
    render();

    expect(w.getError()).toBeNull();
    const dists = endFaceRadialDistances(obj);
    expect(dists.length).toBeGreaterThan(0);
    // glyph end-face centroids sit just under R+1 = 26; buried glyphs would be ~24
    for (const dist of dists) {
      expect(dist).toBeGreaterThan(25.2);
    }
  });

  it("embosses into a bore toward the axis", () => {
    const c1 = cylinder(50, 80);
    const c2 = cylinder(25, 100).translate(0, 0, -10);
    subtract(c1 as unknown as SceneObject, c2 as unknown as SceneObject);

    const s = rectSketch();
    const f = select(face().cylinder(50));
    const w = wrap(1, s, f) as Wrap;
    const obj = w as unknown as SceneObject;
    render();

    expect(w.getError()).toBeNull();
    const tubeVolume = Math.PI * (50 * 50 - 25 * 25) * 80;
    expect(volumeOf(obj)).toBeCloseTo(tubeVolume + PAD_IN, 0);
  });
});
