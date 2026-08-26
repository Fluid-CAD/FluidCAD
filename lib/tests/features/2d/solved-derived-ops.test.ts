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
import local from "../../../core/local.js";
import rotate from "../../../core/rotate.js";
import fillet from "../../../core/fillet.js";
import { line, circle, offset, text, ellipse } from "../../../core/2d/index.js";
import { coincident, horizontal, vertical, fix, distance, radius } from "../../../core/constraints/index.js";
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
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
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(edgesOf(src! as unknown as { getShapes(): unknown[] })).toHaveLength(1);
      expect(edgesOf(cp!)).toHaveLength(2);
      expect(cp!.getInstanceEdges(0)).toHaveLength(1);
      expect(cp!.getInstanceEdges(1)).toHaveLength(1);
      expect(cp!.getInstanceEdges(2)).toHaveLength(1);
    });
  });

  // Post-P6 color cleanup: derived-op duplicates are rigid images of their
  // sources, so the payload ships the solver entities they derive from —
  // sources plus transform inputs — and the viewport tints them with the
  // sources' constrained verdict. `sourcesSolved: false` = no verdict.
  describe("derived-op source verdicts", () => {
    const payloadOf = (scene: Scene, uniqueType: string) =>
      scene.getRenderedObjects().find(r => r.uniqueType === uniqueType)!.object as {
        sourceEntities?: number[]; sourcesSolved?: boolean; entityId?: number;
      };

    it("copy ships its source entity ids", () => {
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        fix(c.center(), [0, 0]);
        copy('linear', 'x', { count: 3, offset: 40 }, c);
      });
      const scene = render();

      const circleId = payloadOf(scene, 'solved-circle').entityId!;
      const cp = payloadOf(scene, 'copy-linear-2d');
      expect(cp.sourcesSolved).toBe(true);
      expect(cp.sourceEntities).toEqual([circleId]);
    });

    it("a local('x') sketch-plane axis is a constant, not an unknown", () => {
      // Regression (2026-08-25): local('x') resolves to AxisFromSketch and
      // the unknown-axis fallback dropped the verdict — copies of a green
      // circle stayed blue.
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        fix(c.center(), [0, 0]);
        radius(c, 10);
        copy('linear', local('x'), { count: 3, length: 100, centered: true }, c);
      });
      const scene = render();

      const circleId = payloadOf(scene, 'solved-circle').entityId!;
      const cp = payloadOf(scene, 'copy-linear-2d');
      expect(cp.sourcesSolved).toBe(true);
      expect(cp.sourceEntities).toEqual([circleId]);
    });

    it("a source without solver identity yields no verdict", () => {
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        fix(c.center(), [0, 0]);
        const o = offset(5, c) as unknown as Offset;
        copy('linear', 'x', { count: 2, offset: 60 }, c, o as unknown as ISolvedCircle);
      });
      const scene = render();

      expect(payloadOf(scene, 'copy-linear-2d').sourcesSolved).toBe(false);
    });

    it("mirror counts the mirror line among its sources", () => {
      sketch('xy', () => {
        const axis = line([0, -10], [0, 60]).guide();
        const c = circle([30, 20], 20);
        fix(c.center(), [30, 20]);
        mirror(axis, c);
      });
      const scene = render();

      const axisId = (payloadOf(scene, 'solved-line') as { entityId: number }).entityId;
      const circleId = payloadOf(scene, 'solved-circle').entityId!;
      const m = payloadOf(scene, 'mirror-shape-2d');
      expect(m.sourcesSolved).toBe(true);
      expect(m.sourceEntities).toEqual([axisId, circleId].sort((a, b) => a - b));
    });

    it("rotate counts an entity-backed center among its sources", () => {
      let pivot: ISolvedCircle;
      sketch('xy', () => {
        pivot = circle([0, 0], 10);
        fix(pivot.center(), [0, 0]);
        const l = line([20, 0], [40, 0]);
        fix(l.start(), [20, 0]);
        fix(l.end(), [40, 0]);
        rotate(90, pivot.center(), true, l);
      });
      const scene = render();

      const circleId = payloadOf(scene, 'solved-circle').entityId!;
      const lineId = (payloadOf(scene, 'solved-line') as { entityId: number }).entityId;
      const rot = payloadOf(scene, 'rotate-shape-2d');
      expect(rot.sourcesSolved).toBe(true);
      expect(rot.sourceEntities).toEqual([circleId, lineId].sort((a, b) => a - b));
    });

  });

  describe("rotate2d", () => {
    it("rotates a copy about an explicit center", () => {
      let rot: { getAddedShapes(): unknown[] };
      sketch('xy', () => {
        const c = circle([30, 0], 20);
        fix(c.center(), [30, 0]);
        rot = rotate(90, [0, 0], true, c) as unknown as { getAddedShapes(): unknown[] };
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(rot!.getAddedShapes().length).toBeGreaterThan(0);
    });

    it("keeps an accessor center out of the target list without a copy flag", () => {
      // rotate(45, l.start(), c): the LazyVertex center must not be eaten
      // by the trailing-targets extraction — it is the center argument.
      let rot: { getAddedShapes(): unknown[]; targetObjects: unknown[] | null };
      let c: ISolvedCircle;
      sketch('xy', () => {
        c = circle([80, 80], 20);
        const l = line([30, 40], [70, 20]);
        rot = rotate(45, l.start(), c) as unknown as {
          getAddedShapes(): unknown[]; targetObjects: unknown[] | null;
        };
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(rot!.targetObjects).toHaveLength(1);
      expect(rot!.targetObjects![0]).toBe(c!);
      expect(rot!.getAddedShapes().length).toBeGreaterThan(0);
    });

    it("refuses the pen-centered form per statement", () => {
      sketch('xy', () => {
        const c = circle([30, 0], 20);
        fix(c.center(), [30, 0]);
        rotate(90, true, c);
      });
      const scene = render();

      const errors = renderedErrors(scene);
      expect(errors.get('rotate-shape-2d')).toMatch(/needs an explicit center/);
    });
  });

  describe("text / ellipse", () => {
    it("lays text along a solved path; the anchored form draws at the origin", () => {
      let pathText: { getShapes(): unknown[] };
      sketch('xy', () => {
        const l = line([0, 0], [120, 0]).guide();
        horizontal(l);
        fix(l.start(), [0, 0]);
        distance(l.start(), l.end(), 120);
        pathText = text('Hi', l) as unknown as { getShapes(): unknown[] };
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(pathText!.getShapes().length).toBeGreaterThan(0);

      // Since P7 the anchored form is legal everywhere: no pen exists, so it
      // draws at the plane origin (or the explicit `.at([x, y])` anchor).
      let anchored: { getShapes(): unknown[] };
      sketch('xy', () => {
        anchored = text('cursorless') as unknown as { getShapes(): unknown[] };
      });
      const errors = renderedErrors(render());
      expect(errors.get('text')).toBeUndefined();
      expect(anchored!.getShapes().length).toBeGreaterThan(0);
    });

    it("draws an ellipse with an explicit center, refusing the pen form", () => {
      let el: { getShapes(): unknown[] };
      sketch('xy', () => {
        el = ellipse([20, 10], 30, 15) as unknown as { getShapes(): unknown[] };
      });
      const scene = render();
      expect(renderedErrors(scene).size).toBe(0);
      expect(edgesOf(el!)).toHaveLength(1);

      // The pen form is gone entirely — the factory refuses at statement time.
      expect(() => sketch('xy', () => { (ellipse as any)(30, 15); }))
        .toThrow(/explicit center/);
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
      }) as unknown as Sketch;
      render();

      // The guide participated in the solve (its horizontal held) …
      const solver = sk.getState('solver-system') as { outcome: string };
      expect(solver.outcome).toBe('solved');
      // … but the profile only sees the circle.
      expect(sk.getEdges()).toHaveLength(1);
    });
  });
});
