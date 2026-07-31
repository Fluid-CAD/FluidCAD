import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import { bezier, circle, move, rect, vLine } from "../../core/2d/index.js";
import { Sketch } from "../../features/2d/sketch.js";
import {
  buildLoftGhostSolids, LoftGhostOptions, LoftGhostProfile, LoftGhostSolids,
} from "../../features/loft-ghost.js";
import { Shape } from "../../common/shape.js";
import { Wire } from "../../common/wire.js";
import { FaceMaker2 } from "../../oc/face-maker2.js";
import { LoftOps } from "../../oc/loft-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { getBoundingBoxOfShapes } from "../utils.js";

const BASE: LoftGhostOptions = {
  op: 'add',
  thin: null,
  guides: [],
  startCondition: null,
  endCondition: null,
};

/** The sketch as the dialog's chip hands it over. */
function section(s: Sketch): LoftGhostProfile {
  return { kind: 'sketch', geometries: s.getGeometries(), plane: s.getPlane() };
}

/**
 * Render once, then hand back the sections those sketches describe. Every
 * test builds all of its sketches first: a second render re-runs their builds
 * and doubles their edges, a harness artifact the renderer never produces.
 */
function sectionsOf(sketches: Sketch[]): LoftGhostProfile[] {
  render();
  return sketches.map(section);
}

/** Two identical 100 × 50 rects, 40 apart — a loft that is exactly a prism. */
function rectStack(): Sketch[] {
  return [
    sketch("xy", () => { rect(100, 50); }) as Sketch,
    sketch(plane("xy", { offset: 40 }), () => { rect(100, 50); }) as Sketch,
  ];
}

/** Two identical circles (diameter 80) at z = 0 and z = 60. */
function circleStack(): Sketch[] {
  return [
    sketch("xy", () => { circle(80); }) as Sketch,
    sketch(plane("xy", { offset: 60 }), () => { circle(80); }) as Sketch,
  ];
}

function ghost(
  profiles: LoftGhostProfile[],
  options: Partial<LoftGhostOptions> = {},
): LoftGhostSolids {
  return buildLoftGhostSolids(profiles, { ...BASE, ...options });
}

function volumeOf(shapes: Shape[]): number {
  return shapes.reduce((sum, s) => sum + ShapeProps.getProperties(s.getShape()).volumeMm3, 0);
}

function disposeGhost(result: LoftGhostSolids): void {
  for (const shape of [...result.solids, ...result.scratch]) {
    shape.dispose();
  }
}

/** Build a ghost, hand the caller its solids, and free everything after. */
function withGhost<T>(
  profiles: LoftGhostProfile[],
  options: Partial<LoftGhostOptions>,
  read: (solids: Shape[]) => T,
): T {
  const result = ghost(profiles, options);
  try {
    return read(result.solids);
  } finally {
    disposeGhost(result);
  }
}

describe("loft ghost", () => {
  setupOC();

  describe("add", () => {
    it("skins through the sections", () => {
      withGhost(sectionsOf(rectStack()), {}, (solids) => {
        expect(solids).toHaveLength(1);
        expect(volumeOf(solids)).toBeCloseTo(100 * 50 * 40, -2);
        const bbox = getBoundingBoxOfShapes(solids);
        expect(bbox.minZ).toBeCloseTo(0, 3);
        expect(bbox.maxZ).toBeCloseTo(40, 3);
      });
    });

    it("builds the same body for 'new' and for the cut's tool", () => {
      const profiles = sectionsOf(rectStack());

      const added = withGhost(profiles, { op: 'add' }, volumeOf);
      const created = withGhost(profiles, { op: 'new' }, volumeOf);
      const cutTool = withGhost(profiles, { op: 'remove' }, volumeOf);

      expect(created).toBeCloseTo(added, 3);
      expect(cutTool).toBeCloseTo(added, 3);
    });

    it("takes a picked face as a section", () => {
      const [bottom, top] = rectStack();
      const [bottomSection, topSection] = sectionsOf([bottom, top]);
      const faces = FaceMaker2.getRegions(bottom.getGeometries(), bottom.getPlane());

      try {
        const fromSketches = withGhost([bottomSection, topSection], {}, volumeOf);
        withGhost([{ kind: 'faces', faces }, topSection], {}, (solids) => {
          expect(solids).toHaveLength(1);
          expect(volumeOf(solids)).toBeCloseTo(fromSketches, 0);
        });
      } finally {
        for (const face of faces) {
          face.dispose();
        }
      }
    });

    it("shows nothing until there are two sections", () => {
      const profiles = sectionsOf(rectStack());

      withGhost([], {}, (solids) => expect(solids).toHaveLength(0));
      withGhost([profiles[0]], {}, (solids) => expect(solids).toHaveLength(0));
    });

    it("shows nothing while a section is still empty", () => {
      const profiles = sectionsOf([
        sketch("xy", () => { }) as Sketch,
        sketch(plane("xy", { offset: 40 }), () => { rect(100, 50); }) as Sketch,
      ]);

      withGhost(profiles, {}, (solids) => expect(solids).toHaveLength(0));
    });
  });

  describe("guides", () => {
    /** A straight rail from (40, 0, 0) to (40, 0, 60) — the cylinder's side. */
    function straightRail(): Sketch {
      return sketch("xz", () => { move([40, 0]); vLine(60); }) as Sketch;
    }

    function railWires(guide: Sketch): Wire[] {
      return WireOps.connectEdgesToWires(guide.getGeometries());
    }

    it("rides the rail", () => {
      const stack = circleStack();
      const bowed = sketch("xz", () => { bezier([40, 0], [65, 30], [40, 60]); }) as Sketch;
      const profiles = sectionsOf(stack);
      const guides = railWires(bowed);

      try {
        withGhost(profiles, { guides }, (solids) => {
          expect(solids).toHaveLength(1);
          // The sections ride out to the rail's bulge, past the straight
          // cylinder's x = 40 side.
          expect(getBoundingBoxOfShapes(solids).maxX).toBeGreaterThan(46);
        });
      } finally {
        for (const wire of guides) {
          wire.dispose();
        }
      }
    });

    it("reproduces the plain loft with a rail down the side", () => {
      const stack = circleStack();
      const rail = straightRail();
      const profiles = sectionsOf(stack);
      const guides = railWires(rail);

      try {
        const plain = withGhost(profiles, {}, volumeOf);
        const railed = withGhost(profiles, { guides }, volumeOf);

        expect(Math.abs(railed - plain) / plain).toBeLessThan(0.05);
      } finally {
        for (const wire of guides) {
          wire.dispose();
        }
      }
    });

    it("shows nothing for more rails than OCC takes, or for rails plus thin walls", () => {
      const stack = circleStack();
      const rails = [straightRail(), straightRail(), straightRail()];
      const profiles = sectionsOf(stack);
      const guides = rails.flatMap(railWires);

      try {
        expect(guides).toHaveLength(3);
        withGhost(profiles, { guides }, (solids) => expect(solids).toHaveLength(0));
        withGhost(profiles, { guides: guides.slice(0, 1), thin: [2] }, (solids) => {
          expect(solids).toHaveLength(0);
        });
      } finally {
        for (const wire of guides) {
          wire.dispose();
        }
      }
    });

    it("shows nothing for a multi-region section under a rail", () => {
      const rail = straightRail();
      const profiles = sectionsOf([
        sketch("xy", () => { circle(80); move([200, 0]); circle(80); }) as Sketch,
        sketch(plane("xy", { offset: 60 }), () => { circle(80); }) as Sketch,
      ]);
      const guides = railWires(rail);

      try {
        withGhost(profiles, { guides }, (solids) => expect(solids).toHaveLength(0));
      } finally {
        for (const wire of guides) {
          wire.dispose();
        }
      }
    });
  });

  describe("conditions", () => {
    it("pins the takeoff — a different surface from the plain skin", () => {
      const profiles = sectionsOf(circleStack());

      const plain = withGhost(profiles, {}, volumeOf);
      const constrained = withGhost(
        profiles,
        { startCondition: { kind: 'tangent', magnitude: 1 } },
        volumeOf,
      );

      expect(constrained).toBeGreaterThan(0);
      expect(Math.abs(constrained - plain) / plain).toBeGreaterThan(0.01);
    });
  });

  describe("thin", () => {
    it("skins the offset shell rather than the filled sections", () => {
      const profiles = sectionsOf(rectStack());

      const filled = withGhost(profiles, {}, volumeOf);
      const thin = withGhost(profiles, { thin: [2] }, volumeOf);

      expect(thin).toBeGreaterThan(0);
      // A 2 mm wall around a 100 × 50 outline, 40 tall: the perimeter's worth
      // of material, a fraction of the filled body.
      expect(thin).toBeLessThan(filled * 0.2);
      expect(thin).toBeCloseTo(300 * 2 * 40, -4);
    });

    it("shows nothing for a picked face — only sketches offset", () => {
      const [bottom, top] = rectStack();
      const [, topSection] = sectionsOf([bottom, top]);
      const faces = FaceMaker2.getRegions(bottom.getGeometries(), bottom.getPlane());

      try {
        withGhost([{ kind: 'faces', faces }, topSection], { thin: [2] }, (solids) => {
          expect(solids).toHaveLength(0);
        });
      } finally {
        for (const face of faces) {
          face.dispose();
        }
      }
    });
  });

  describe("lifetime", () => {
    it("survives repeated build + dispose cycles", () => {
      const profiles = sectionsOf(rectStack());

      for (let i = 0; i < 30; i++) {
        const result = ghost(profiles, {});
        expect(result.solids).toHaveLength(1);
        disposeGhost(result);
      }

      // The sections are untouched by all of that — the ghost only reads them.
      const first = profiles[0];
      expect(first.kind === 'sketch' && first.geometries.every(e => !e.isReleased())).toBe(true);
    });

    it("frees its scratch when the skin throws", () => {
      const [bottom, top] = rectStack();
      const profiles = sectionsOf([bottom, top]);

      // Hand the builder a region set we keep a handle on, then make the skin
      // fail: the scratch has to come back released, not stranded out of the
      // caller's reach.
      const regions = FaceMaker2.getRegions(bottom.getGeometries(), bottom.getPlane());
      const split = vi.spyOn(FaceMaker2, 'getRegions').mockReturnValue(regions);
      const skin = vi.spyOn(LoftOps, 'makeLoft').mockImplementation(() => {
        throw new Error('ghost skin failed');
      });

      try {
        expect(regions.length).toBeGreaterThan(0);
        expect(() => buildLoftGhostSolids(profiles, BASE)).toThrow('ghost skin failed');
        expect(regions.every(f => f.isReleased())).toBe(true);
      } finally {
        skin.mockRestore();
        split.mockRestore();
      }
    });
  });
});
