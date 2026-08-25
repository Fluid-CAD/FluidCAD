// P6 derived-op audit: every edge-consuming derived op runs against SOLVED
// (constraint-mode) sketches. They consume built edges, not pen state, so
// they should be inert to the mode — these tests pin that, plus the
// solved-mode guards (no pen-state writes, explicit rotate center,
// pen-anchored text/ellipse rejections).
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import mirror from "../../../core/mirror.js";
import copy from "../../../core/copy.js";
import rotate from "../../../core/rotate.js";
import fillet from "../../../core/fillet.js";
import { line, circle, offset, text, ellipse } from "../../../core/2d/index.js";
import { coincident, horizontal, vertical, fix, distance } from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Offset } from "../../../features/2d/offset.js";
import { Fillet2D } from "../../../features/fillet2d.js";
import { Copy2DBase } from "../../../features/copy2d-base.js";
import { Edge } from "../../../common/edge.js";
import { Scene } from "../../../rendering/scene.js";
import type { ISolvedLine, ISolvedCircle } from "../../../core/interfaces.js";

const edgesOf = (obj: { getShapes(): unknown[] }): Edge[] =>
  obj.getShapes().filter((s): s is Edge => s instanceof Edge);

function renderedErrors(scene: Scene): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of scene.getRenderedObjects()) {
    if (r.errorMessage) {
      out.set(r.uniqueType, r.errorMessage);
    }
  }
  return out;
}

describe("derived ops on solved sketches (P6 audit)", () => {
  setupOC();

  describe("offset", () => {
    it("offsets a solved profile and never writes pen state", () => {
      let o: Offset;
      sketch('xy', () => {
        const b = line([1, -2], [99, 3]);
        const r = line([99, 3], [101, 52]);
        const t = line([101, 52], [-2, 48]);
        const l = line([-2, 48], [1, -2]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        vertical(r);
        horizontal(t);
        vertical(l);
        fix(b.start(), [0, 0]);
        distance(b.start(), b.end(), 100);
        distance(r.start(), r.end(), 50);
        o = offset(5, b, r, t, l) as unknown as Offset;
      }, true);
      render();

      // A closed solved loop offsets to a closed outline of SOLVED geometry:
      // the +5 outline spans (-5,-5)..(105,55) — guesses would miss by units.
      const offsetEdges = edgesOf(o);
      expect(offsetEdges.length).toBeGreaterThanOrEqual(4);
      expect(offsetEdges.every(e => e.provenance === 'offset-of')).toBe(true);

      // No pen state in a solved sketch — the offset must not become a
      // phantom cursor for getPositionAt.
      expect(o.getState('start')).toBeUndefined();
      expect(o.getState('end')).toBeUndefined();
    });

    it("offsets a solved circle and extrudes the ring's outer face region", () => {
      let o: Offset;
      sketch('xy', () => {
        const c = circle([50, 40], 40);
        fix(c.center(), [50, 40]);
        o = offset(5, c) as unknown as Offset;
      }, true);
      const e = extrude(10, o!) as ExtrudeBase;
      render();

      // The extrude consumed the offset's edges — inspect the raw adds.
      const offsetEdges = o!.getAddedShapes().filter((s): s is Edge => s instanceof Edge);
      expect(offsetEdges).toHaveLength(1);
      expect(e.getShapes()[0].getType()).toBe('solid');
    });
  });

  describe("fillet2d", () => {
    it("rounds a solved corner, consuming the corner edges", () => {
      let f: Fillet2D;
      let a: ISolvedLine;
      let b: ISolvedLine;
      sketch('xy', () => {
        a = line([0, 0], [40, 0]);
        b = line([40, 0], [40, 30]);
        coincident(a.end(), b.start());
        horizontal(a);
        vertical(b);
        fix(a.start(), [0, 0]);
        f = fillet(6, a, b) as Fillet2D;
      }, true);
      const scene = render();

      const arcs = edgesOf(f!).filter(e => e.provenance === 'fillet-arc');
      expect(arcs).toHaveLength(1);

      // The solver system is untouched by the consumption: the solved
      // entities still serialize their solved geometry (badges, drag and
      // write-back all read it), even though the fillet owns their edges now.
      const solvedLines = scene.getRenderedObjects().filter(r => r.uniqueType === 'solved-line');
      expect(solvedLines).toHaveLength(2);
      expect((solvedLines[0].object as { entityId: number }).entityId).toBeGreaterThanOrEqual(0);
    });
  });

  describe("mirror2d / copy2d", () => {
    it("mirrors explicit solved targets across a solved line", () => {
      let mirrored: { getShapes(): unknown[] };
      sketch('xy', () => {
        const axis = line([0, -10], [0, 60]).guide();
        const c = circle([30, 20], 20);
        fix(c.center(), [30, 20]);
        mirrored = mirror(axis, c) as unknown as { getShapes(): unknown[] };
      }, true);
      render();

      const copies = edgesOf(mirrored!).filter(e => !e.isMetaShape());
      expect(copies.length).toBeGreaterThan(0);
      expect(copies.every(e => e.provenance === 'mirror-copy')).toBe(true);
    });

    it("target-less mirror skips constraint statements in the sibling walk", () => {
      let mirrored: { getShapes(): unknown[]; getError(): string | null };
      sketch('xy', () => {
        const axis = line([0, -10], [0, 60]).guide();
        const c = circle([30, 20], 20);
        fix(c.center(), [30, 20]);
        mirrored = mirror(axis) as unknown as { getShapes(): unknown[]; getError(): string | null };
      }, true);
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(edgesOf(mirrored!).some(e => e.provenance === 'mirror-copy')).toBe(true);
    });

    it("copies a solved circle on a linear grid", () => {
      let cp: Copy2DBase;
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        fix(c.center(), [0, 0]);
        cp = copy('linear', 'x', { count: 3, offset: 40 }, c) as unknown as Copy2DBase;
      }, true);
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(cp!.getInstanceEdges(0)).toHaveLength(1);
      expect(cp!.getInstanceEdges(2)).toHaveLength(1);
    });

    it("copy never owns the original — the solved source keeps its own edge", () => {
      // Ownership contract (2026-08-25): a copy owns only the duplicates it
      // stamps. The source statement keeps its shapes, so the solved circle
      // stays an independent, pickable/draggable entity while instance(0)
      // still resolves the original's slot through it.
      let src: ISolvedCircle;
      let cp: Copy2DBase;
      sketch('xy', () => {
        src = circle([0, 0], 20) as ISolvedCircle;
        fix(src.center(), [0, 0]);
        cp = copy('linear', 'x', { count: 3, offset: 40 }, src) as unknown as Copy2DBase;
      }, true);
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(edgesOf(src! as unknown as { getShapes(): unknown[] })).toHaveLength(1);
      expect(edgesOf(cp!)).toHaveLength(2);
      expect(cp!.getInstanceEdges(0)).toHaveLength(1);
      expect(cp!.getInstanceEdges(1)).toHaveLength(1);
      expect(cp!.getInstanceEdges(2)).toHaveLength(1);
    });
  });

  describe("rotate2d", () => {
    it("rotates a copy about an explicit center", () => {
      let rot: { getAddedShapes(): unknown[] };
      sketch('xy', () => {
        const c = circle([30, 0], 20);
        fix(c.center(), [30, 0]);
        rot = rotate(90, [0, 0], true, c) as unknown as { getAddedShapes(): unknown[] };
      }, true);
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(rot!.getAddedShapes().length).toBeGreaterThan(0);
    });

    it("refuses the pen-centered form per statement", () => {
      sketch('xy', () => {
        const c = circle([30, 0], 20);
        fix(c.center(), [30, 0]);
        rotate(90, true, c);
      }, true);
      const scene = render();

      const errors = renderedErrors(scene);
      expect(errors.get('rotate-shape-2d')).toMatch(/needs an explicit center/);
    });
  });

  describe("text / ellipse", () => {
    it("lays text along a solved path but refuses the pen-anchored form", () => {
      let pathText: { getShapes(): unknown[] };
      sketch('xy', () => {
        const l = line([0, 0], [120, 0]).guide();
        horizontal(l);
        fix(l.start(), [0, 0]);
        distance(l.start(), l.end(), 120);
        pathText = text('Hi', l) as unknown as { getShapes(): unknown[] };
      }, true);
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(pathText!.getShapes().length).toBeGreaterThan(0);

      sketch('xy', () => {
        text('cursorless');
      }, true);
      const errors = renderedErrors(render());
      expect(errors.get('text')).toMatch(/sketch cursor/);
    });

    it("draws an ellipse with an explicit center, refusing the pen form", () => {
      let el: { getShapes(): unknown[] };
      sketch('xy', () => {
        el = ellipse([20, 10], 30, 15) as unknown as { getShapes(): unknown[] };
      }, true);
      const scene = render();
      expect(renderedErrors(scene).size).toBe(0);
      expect(edgesOf(el!)).toHaveLength(1);

      sketch('xy', () => {
        ellipse(30, 15);
      }, true);
      const errors = renderedErrors(render());
      expect(errors.get('ellipse')).toMatch(/sketch cursor/);
    });
  });

  describe("guides", () => {
    it("guide entities solve as free entities but stay out of profiles", () => {
      let c: ISolvedCircle;
      const sk = sketch('xy', () => {
        const g = line([0, 0], [80, 2]);
        g.guide();
        horizontal(g);
        fix(g.start(), [0, 0]);
        c = circle([40, 30], 30);
        coincident(c.center(), g.mid());
      }, true) as unknown as Sketch;
      render();

      // The guide participated in the solve (its horizontal held) …
      const solver = sk.getState('solver-system') as { outcome: string };
      expect(solver.outcome).toBe('solved');
      // … but the profile only sees the circle.
      expect(sk.getEdges()).toHaveLength(1);
    });
  });
});
