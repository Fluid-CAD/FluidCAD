import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import wrap from "../../core/wrap.js";
import extrude from "../../core/extrude.js";
import revolve from "../../core/revolve.js";
import cylinder from "../../core/cylinder.js";
import select from "../../core/select.js";
import plane from "../../core/plane.js";
import { circle, line, move, rect, slot, text, vMove } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Wrap } from "../../features/wrap.js";
import { Extrude } from "../../features/extrude.js";
import { Face } from "../../common/face.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeProps } from "../../oc/props.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { countShapes } from "../utils.js";

const CYLINDER_VOLUME = Math.PI * 50 * 50 * 100;
// A wrapped pad between radii R and R+t with arc width s and height h has
// volume (s/R)/2 · ((R+t)² - R²) · h.
const EMBOSS_PAD_VOLUME = ((20 / 50) / 2) * (52 * 52 - 50 * 50) * 10;
const DEBOSS_PAD_VOLUME = ((20 / 50) / 2) * (50 * 50 - 48 * 48) * 10;

function volumeOf(obj: SceneObject): number {
  return obj.getShapes().reduce(
    (sum, shape) => sum + ShapeProps.getProperties(shape.getShape()).volumeMm3, 0);
}

function facesState(obj: SceneObject, key: string): Face[] {
  return (obj.getState(key) as Face[]) || [];
}

/** Cylinder R=50 spanning z ∈ [-50, 50], plus a tangent sketch plane at y = -50. */
function setupCylinderScene() {
  const target = cylinder(50, 100).translate(0, 0, -50);
  const faceSelection = select(face().cylinder());
  return { target, faceSelection };
}

describe("wrap", () => {
  setupOC();

  describe("emboss (default add)", () => {
    it("fuses a wrapped rectangle pad with the cylinder", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      const w = wrap(2, faceSelection) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      expect(volumeOf(w)).toBeCloseTo(CYLINDER_VOLUME + EMBOSS_PAD_VOLUME, 0);
    });

    it("classifies start, end and side faces", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      const w = wrap(2, faceSelection) as Wrap;
      render();

      expect(facesState(w, 'start-faces')).toHaveLength(1);
      expect(facesState(w, 'end-faces')).toHaveLength(1);
      expect(facesState(w, 'side-faces')).toHaveLength(4);
      expect(facesState(w, 'internal-faces')).toHaveLength(0);
    });

    it("classifies end faces of regions far around the cylinder", () => {
      // Regions whose wrapped angle exceeds ~45° of the sketch anchor used to
      // land in side-faces: the face normal was sampled at fixed UV (0, 0)
      // instead of at the same point as the development-normal probe.
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(10, 10);
        move([60, 0]);
        rect(10, 10);
        move([-60, 0]);
        rect(10, 10);
      });

      const w = wrap(2, faceSelection) as Wrap;
      render();

      expect(w.getError()).toBeNull();
      expect(facesState(w, 'start-faces')).toHaveLength(3);
      expect(facesState(w, 'end-faces')).toHaveLength(3);
      expect(facesState(w, 'side-faces')).toHaveLength(12);
      expect(facesState(w, 'internal-faces')).toHaveLength(0);
    });

    it("classifies hole walls as internal faces", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(20, 10);
        move([6, 3]);
        rect(8, 4);
      });

      const w = wrap(2, faceSelection) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(facesState(w, 'end-faces')).toHaveLength(1);
      expect(facesState(w, 'side-faces')).toHaveLength(4);
      expect(facesState(w, 'internal-faces')).toHaveLength(4);

      // Annulus region (200 - 32 = 168 mm²): the hole must be subtracted from
      // the pad, not added to it (wire-winding regression).
      const annulusPadVolume = (168 / 50) * ((52 * 52 - 50 * 50) / 2);
      expect(countShapes(scene)).toBe(1);
      expect(volumeOf(w)).toBeCloseTo(CYLINDER_VOLUME + annulusPadVolume, 0);
    });

    it("wraps an explicitly passed sketch", () => {
      const { faceSelection } = setupCylinderScene();
      const decal = sketch(plane("front", 50), () => {
        rect(20, 10);
      });
      sketch(plane("front", 60), () => {
        rect(6, 6);
      });

      const w = wrap(2, decal, faceSelection) as Wrap;
      render();

      expect(w.getError()).toBeNull();
      expect(volumeOf(w)).toBeCloseTo(CYLINDER_VOLUME + EMBOSS_PAD_VOLUME, 0);
    });
  });

  describe("remove (deboss)", () => {
    it("cuts a wrapped pocket into the cylinder", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      const w = wrap(2, faceSelection).remove() as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      expect(volumeOf(w)).toBeCloseTo(CYLINDER_VOLUME - DEBOSS_PAD_VOLUME, 0);
    });
  });

  describe("new (standalone)", () => {
    it("keeps the wrapped pad separate from the cylinder", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      const w = wrap(2, faceSelection).new() as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(2);
      expect(w.getShapes()).toHaveLength(1);
      expect(volumeOf(w)).toBeCloseTo(EMBOSS_PAD_VOLUME, 0);
    });
  });

  describe("scope", () => {
    function setupScopeScene() {
      const { target, faceSelection } = setupCylinderScene();
      // A box hovering just off the cylinder surface, overlapping the region
      // the pad will occupy (pad spans y ∈ [-52, -50]).
      sketch(plane("front", 50.5), () => {
        rect(40, 30);
      });
      extrude(10) as Extrude;

      sketch(plane("front", 50), () => {
        rect(20, 10);
      });
      return { target, faceSelection };
    }

    it("fuses with every intersecting object by default", () => {
      const { faceSelection } = setupScopeScene();

      const w = wrap(2, faceSelection) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
    });

    it("fuses only with the scoped object", () => {
      const { target, faceSelection } = setupScopeScene();

      const w = wrap(2, faceSelection).add().scope(target) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(2);
    });
  });

  describe("validation", () => {
    it("rejects a non-positive thickness", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      expect(() => wrap(0, faceSelection)).toThrow(/positive/);
      expect(() => wrap(-2, faceSelection)).toThrow(/positive/);
    });

    it("requires a target face argument", () => {
      setupCylinderScene();
      const decal = sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      expect(() => (wrap as any)(2)).toThrow();
      expect(() => wrap(2, decal)).toThrow(/target face/);
    });

    it("reports an error for planar target faces", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const base = extrude(10) as Extrude;
      sketch(plane("xy", 20), () => {
        rect(10, 10);
      });

      const w = wrap(2, base.endFaces()) as Wrap;
      render();

      expect(w.getError()).toMatch(/cylindrical or conical/);
    });
  });

  describe("curved sketch edges", () => {
    it("wraps a circle onto the cylinder", () => {
      const { faceSelection } = setupCylinderScene();
      sketch(plane("front", 50), () => {
        circle(10);
      });

      const w = wrap(2, faceSelection) as Wrap;
      const scene = render();

      // Disc of radius 5: wrapped pad volume = (A/R) · ((R+t)² - R²) / 2.
      const padVolume = ((Math.PI * 25) / 50) * ((52 * 52 - 50 * 50) / 2);
      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      expect(volumeOf(w)).toBeCloseTo(CYLINDER_VOLUME + padVolume, 0);
    });

    it("wraps onto a conical face", () => {
      // Frustum: r=50 at z=0 down to r=30 at z=100.
      sketch("xz", () => {
        line([0, 0], [50, 0]);
        line([50, 0], [30, 100]);
        line([30, 100], [0, 100]);
        line([0, 100], [0, 0]);
      });
      revolve("z");
      const faceSelection = select(face().cone());

      // Sketch plane outside the cone band around z = 50 (surface radius 40).
      const tangent = plane(new Plane(
        new Point(0, -41, 50),
        new Vector3d(1, 0, 0),
        new Vector3d(0, -1, 0),
      ));
      sketch(tangent, () => {
        rect(8, 6);
      });

      const w = wrap(2, faceSelection) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      expect(facesState(w, 'end-faces')).toHaveLength(1);
      expect(facesState(w, 'side-faces')).toHaveLength(4);
    });
  });

  describe("slot decals", () => {
    // The slot's tangent line-to-arc junctions exposed the miscompiled
    // Geom2dAPI_PointsToBSpline binding (cap pcurves bulged 70% past the
    // samples, rendering as fins). The in-house interpolation keeps the
    // wrapped boundary exact.
    it("wraps a slot with an exact pad volume", () => {
      cylinder(25, 80).translate(0, 0, 0);
      const faceSelection = select(face().cylinder());
      sketch(plane("front", 40), () => {
        slot([0, 10], [0, 50], 5);
      });

      const w = wrap(1, faceSelection) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      // Slot region (10×40 rect + π·5² disc) wrapped from r=25 to r=26.
      const area = 10 * 40 + Math.PI * 25;
      const expected = Math.PI * 625 * 80 + (area / 25) * ((26 * 26 - 25 * 25) / 2);
      expect(volumeOf(w)).toBeCloseTo(expected, 1);
    });
  });

  describe("text decals", () => {
    // Many small multi-wire regions (glyphs with counters) in pure surface
    // contact — the case that exposed both the hole-winding bug and the
    // unreliable zero-volume-contact booleans.
    function setupTextScene() {
      cylinder(25, 80);
      const decal = sketch(plane("front", 40), () => {
        vMove(20);
        text("hello world");
      });
      const faceSelection = select(face().cylinder());
      return { decal, faceSelection };
    }

    it("embosses every glyph onto the cylinder as one solid", () => {
      const { decal, faceSelection } = setupTextScene();

      const w = wrap(1, decal, faceSelection) as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      expect(w.getShapes()).toHaveLength(1);
      expect(volumeOf(w)).toBeGreaterThan(Math.PI * 25 * 25 * 80);
    });

    it("classifies an end face for every glyph of a centered decal", () => {
      // User repro: centered text on an extruded cylinder — the outermost
      // glyphs ("h", "d") wrap more than 45° away from the sketch anchor and
      // used to lose their end-face classification.
      sketch("top", () => {
        circle(50);
      });
      extrude(80);
      const decal = sketch(plane("front", 30), () => {
        vMove(20);
        text("hello world").align('center');
      });
      const faceSelection = select(face().cylinder());

      const w = wrap(1, decal, faceSelection) as Wrap;
      render();

      expect(w.getError()).toBeNull();
      const startFaces = facesState(w, 'start-faces');
      expect(startFaces.length).toBeGreaterThan(0);
      expect(facesState(w, 'end-faces')).toHaveLength(startFaces.length);
    });

    it("engraves every glyph into the cylinder", () => {
      const { decal, faceSelection } = setupTextScene();

      const w = wrap(1, decal, faceSelection).remove() as Wrap;
      const scene = render();

      expect(w.getError()).toBeNull();
      expect(countShapes(scene)).toBe(1);
      expect(w.getShapes()).toHaveLength(1);
      const cylinderVolume = Math.PI * 25 * 25 * 80;
      const volume = volumeOf(w);
      expect(volume).toBeLessThan(cylinderVolume);
      expect(volume).toBeGreaterThan(cylinderVolume * 0.99);
    });
  });

  describe("compareTo", () => {
    it("matches identical wraps and rejects different thicknesses", () => {
      const { faceSelection } = setupCylinderScene();
      const decal = sketch(plane("front", 50), () => {
        rect(20, 10);
      });

      const a = new Wrap(2, faceSelection as SceneObject, decal as any);
      const b = new Wrap(2, faceSelection as SceneObject, decal as any);
      const c = new Wrap(3, faceSelection as SceneObject, decal as any);

      expect(a.compareTo(b)).toBe(true);
      expect(a.compareTo(c)).toBe(false);
    });
  });
});
