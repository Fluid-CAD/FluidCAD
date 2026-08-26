import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import { circle } from "../../core/2d/index.js";
import { testRect } from "../helpers/profiles.js";
import { Sketch } from "../../features/2d/sketch.js";
import { buildExtrudeGhostSolids, ExtrudeGhostOptions, ExtrudeGhostSolids } from "../../features/extrude-ghost.js";
import { Extruder } from "../../features/simple-extruder.js";
import { Shape } from "../../common/shape.js";
import { FaceMaker2 } from "../../oc/face-maker2.js";
import { ShapeProps } from "../../oc/props.js";
import { getBoundingBoxOfShapes } from "../utils.js";

const BASE: ExtrudeGhostOptions = {
  op: 'add',
  distance: 10,
  distance2: null,
  symmetric: false,
  draft: null,
  endOffset: null,
  drill: true,
  thin: null,
  throughAllLength: 60,
};

/** A rendered `xy` sketch holding whatever `draw` puts in it. */
function profile(draw: () => void): Sketch {
  const s = sketch("xy", draw) as Sketch;
  render();
  return s;
}

function ghost(source: Sketch, options: Partial<ExtrudeGhostOptions> = {}): ExtrudeGhostSolids {
  return buildExtrudeGhostSolids(source, { ...BASE, ...options });
}

function volumeOf(shapes: Shape[]): number {
  return shapes.reduce((sum, s) => sum + ShapeProps.getProperties(s.getShape()).volumeMm3, 0);
}

function disposeGhost(result: ExtrudeGhostSolids): void {
  for (const shape of result.solids) {
    shape.dispose();
  }
  for (const shape of result.scratch) {
    shape.dispose();
  }
}

/** Build a ghost, hand the caller its solids, and free everything after. */
function withGhost<T>(
  source: Sketch,
  options: Partial<ExtrudeGhostOptions>,
  read: (solids: Shape[]) => T,
): T {
  const result = ghost(source, options);
  try {
    return read(result.solids);
  } finally {
    disposeGhost(result);
  }
}

describe("extrude ghost", () => {
  setupOC();

  describe("add", () => {
    it("sweeps the profile along the normal", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 10 }, (solids) => {
        expect(solids).toHaveLength(1);
        expect(volumeOf(solids)).toBeCloseTo(100 * 50 * 10, 0);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(0, 3);
        expect(bbox.maxZ).toBeCloseTo(10, 3);
      });
    });

    it("builds the same body for 'new' as for 'add' — only the fusion scope differs", () => {
      const s = profile(() => { testRect(100, 50); });

      const added = withGhost(s, { op: 'add' }, volumeOf);
      const created = withGhost(s, { op: 'new' }, volumeOf);

      expect(created).toBeCloseTo(added, 3);
    });

    it("shows nothing for a through-all that is not a cut", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { op: 'add', distance: null }, (solids) => {
        expect(solids).toHaveLength(0);
      });
    });

    it("shows nothing for an empty sketch", () => {
      const s = profile(() => { });

      withGhost(s, {}, (solids) => {
        expect(solids).toHaveLength(0);
      });
    });
  });

  describe("symmetric", () => {
    it("centers the body on the sketch plane, keeping the total distance", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 30, symmetric: true }, (solids) => {
        expect(volumeOf(solids)).toBeCloseTo(100 * 50 * 30, 0);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-15, 3);
        expect(bbox.maxZ).toBeCloseTo(15, 3);
      });
    });

    it("stays one body — the halves are fused, never left coincident", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 30, symmetric: true, draft: 5 }, (solids) => {
        expect(solids).toHaveLength(1);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-15, 3);
        expect(bbox.maxZ).toBeCloseTo(15, 3);
      });
    });
  });

  describe("two distances", () => {
    it("runs the first distance along the normal and the second against it", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 10, distance2: 4 }, (solids) => {
        expect(volumeOf(solids)).toBeCloseTo(100 * 50 * 14, 0);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-4, 3);
        expect(bbox.maxZ).toBeCloseTo(10, 3);
      });
    });
  });

  describe("end offset", () => {
    it("pulls the swept end back toward the sketch plane", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 10, endOffset: 3 }, (solids) => {
        expect(volumeOf(solids)).toBeCloseTo(100 * 50 * 7, 0);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(0, 3);
        expect(bbox.maxZ).toBeCloseTo(7, 3);
      });
    });

    it("pushes it past the distance when negative", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 10, endOffset: -2 }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(0, 3);
        expect(bbox.maxZ).toBeCloseTo(12, 3);
      });
    });

    it("pulls both ends of a symmetric extrude in — one offset per sweep", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 30, symmetric: true, endOffset: 5 }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-10, 3);
        expect(bbox.maxZ).toBeCloseTo(10, 3);
      });
    });

    it("pulls a cut's end back — the tool sweeps anti-normal", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { op: 'remove', distance: 10, endOffset: 4 }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-6, 3);
        expect(bbox.maxZ).toBeCloseTo(0, 3);
      });
    });

    it("shows nothing once the offset eats the whole distance", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 10, endOffset: 10 }, (solids) => {
        expect(solids).toHaveLength(0);
      });
    });
  });

  describe("drill", () => {
    it("leaves the inner region hollow by default and solid when off", () => {
      const s = profile(() => { circle([0, 0], 100); circle([0, 0], 40); });

      const drilled = withGhost(s, { drill: true }, volumeOf);
      const solid = withGhost(s, { drill: false }, volumeOf);

      expect(solid).toBeCloseTo(Math.PI * 50 * 50 * 10, 0);
      expect(drilled).toBeCloseTo(Math.PI * (50 * 50 - 20 * 20) * 10, 0);
    });
  });

  describe("thin", () => {
    it("sweeps the offset shell rather than the filled profile", () => {
      const s = profile(() => { testRect(100, 50); });

      const filled = withGhost(s, {}, volumeOf);
      const thin = withGhost(s, { thin: [2] }, volumeOf);

      expect(thin).toBeGreaterThan(0);
      // A 2 mm wall around a 100 × 50 outline: the perimeter's worth of
      // material, a fraction of the filled body.
      expect(thin).toBeLessThan(filled * 0.2);
      expect(thin).toBeCloseTo(300 * 2 * 10, -3);
    });
  });

  describe("remove", () => {
    it("sweeps the tool into the material, against the normal", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { op: 'remove', distance: 10 }, (solids) => {
        expect(volumeOf(solids)).toBeCloseTo(100 * 50 * 10, 0);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-10, 3);
        expect(bbox.maxZ).toBeCloseTo(0, 3);
      });
    });

    it("runs a through-all cut to the caller's ghost length, not the kernel's 100 m", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { op: 'remove', distance: null, throughAllLength: 60 }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-60, 3);
        expect(bbox.maxZ).toBeCloseTo(0, 3);
      });
    });

    it("runs a symmetric through-all cut both ways", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { op: 'remove', distance: null, symmetric: true, throughAllLength: 60 }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-60, 3);
        expect(bbox.maxZ).toBeCloseTo(60, 3);
      });
    });

    it("centers a symmetric cut of a given depth on the sketch plane", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { op: 'remove', distance: 30, symmetric: true }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(-15, 3);
        expect(bbox.maxZ).toBeCloseTo(15, 3);
      });
    });
  });

  describe("draft", () => {
    it("tapers the walls — the body no longer matches the straight prism", () => {
      const s = profile(() => { testRect(100, 50); });

      const straight = withGhost(s, { distance: 20 }, volumeOf);
      const drafted = withGhost(s, { distance: 20, draft: 10 }, volumeOf);

      expect(Math.abs(drafted - straight)).toBeGreaterThan(straight * 0.01);
      // The end face moved; the profile face is still the sketch's.
      withGhost(s, { distance: 20, draft: 10 }, (solids) => {
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(0, 3);
        expect(bbox.maxZ).toBeCloseTo(20, 3);
      });
    });
  });

  describe("lifetime", () => {
    it("survives repeated build + dispose cycles", () => {
      const s = profile(() => { testRect(100, 50); });

      for (let i = 0; i < 50; i++) {
        const result = ghost(s, { distance: 5 + i });
        expect(result.solids).toHaveLength(1);
        disposeGhost(result);
      }

      // The profile is untouched by all of that — the ghost only ever reads it.
      expect(s.getGeometries().length).toBeGreaterThan(0);
    });

    it("frees its scratch when the build throws", () => {
      const s = profile(() => { testRect(100, 50); });

      // Hand the builder a face set we keep a handle on, then make the sweep
      // fail: the scratch has to come back released, not stranded out of the
      // caller's reach.
      const faces = FaceMaker2.getRegions(s.getGeometries(), s.getPlane(), true);
      const regions = vi.spyOn(FaceMaker2, 'getRegions').mockReturnValue(faces);
      const sweep = vi.spyOn(Extruder.prototype, 'extrude').mockImplementation(() => {
        throw new Error('ghost build failed');
      });

      try {
        expect(faces.length).toBeGreaterThan(0);
        expect(() => buildExtrudeGhostSolids(s, BASE)).toThrow('ghost build failed');
        expect(faces.every(f => f.isReleased())).toBe(true);
      } finally {
        sweep.mockRestore();
        regions.mockRestore();
      }
    });

    it("shows nothing for a distance that resolved to zero", () => {
      const s = profile(() => { testRect(100, 50); });

      withGhost(s, { distance: 0 }, (solids) => {
        expect(solids).toHaveLength(0);
      });
    });
  });
});
