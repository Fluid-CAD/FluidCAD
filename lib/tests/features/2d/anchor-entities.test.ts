// P8 entity-coverage regressions: ellipse centers, bezier control points
// and text anchors are solver POINT entities — constraints target them,
// the solve moves them, and the build reflects the solved positions.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line, circle, ellipse, bezier, text } from "../../../core/2d/index.js";
import { coincident, horizontal, vertical, fix, distance } from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Scene } from "../../../rendering/scene.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { getBoundingBoxOfShapes } from "../../utils.js";

function payloadOf(scene: Scene, obj: unknown) {
  return scene.getRenderedObject(obj as SceneObject).object;
}

describe("anchor entities (ellipse / bezier / text in the solver)", () => {
  setupOC();

  describe("ellipse center", () => {
    it("solves a coincident ellipse center onto a dimensioned line end", () => {
      let el: unknown;
      sketch('xy', () => {
        const l = line([1, -2], [99, 3]).guide();
        fix(l.start(), [0, 0]);
        horizontal(l);
        distance(l.start(), l.end(), 100);
        const e = ellipse([80, 20], 30, 15);
        el = e;
        coincident(e.center(), l.end());
      });
      const e3d = extrude(10) as ExtrudeBase;
      const scene = render();

      const payload = payloadOf(scene, el);
      expect(payload.center.x).toBeCloseTo(100, 6);
      expect(payload.center.y).toBeCloseTo(0, 6);

      const bbox = ShapeOps.getBoundingBox(e3d.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(100, 0);
      expect(bbox.centerY).toBeCloseTo(0, 0);
    });

    it("moves the ellipse through fix() on its center and reports the DOF", () => {
      let el: unknown;
      const s = sketch('xy', () => {
        const e = ellipse([3, 4], 20, 10);
        el = e;
        fix(e.center(), [40, 25]);
      }) as unknown as Sketch;
      const scene = render();

      const elPayload = payloadOf(scene, el);
      expect(elPayload.center.x).toBeCloseTo(40, 6);
      expect(elPayload.center.y).toBeCloseTo(25, 6);

      const sketchPayload = payloadOf(scene, s);
      expect(sketchPayload.solver.outcome).toBe('solved');
      expect(sketchPayload.solver.dof).toBe(0);
      // Exactly one statement entity: the center point.
      const statementEntities = sketchPayload.solver.entities.filter((e: any) => e.id >= 0);
      expect(statementEntities).toHaveLength(1);
      expect(statementEntities[0].kind).toBe('point');
    });

    it("serializes the solver join fields (entityId + statement-time guess)", () => {
      let el: unknown;
      sketch('xy', () => {
        el = ellipse([3, 4], 20, 10);
      });
      const scene = render();

      const payload = payloadOf(scene, el);
      expect(payload.entityId).toBeGreaterThanOrEqual(0);
      expect(payload.guess).toEqual({ center: { x: 3, y: 4 } });
      // Unconstrained: the center stays at its literal.
      expect(payload.center).toEqual({ x: 3, y: 4 });
    });

    it("attributes conflicting constraints on the center to their statements", () => {
      let f1: unknown;
      let f2: unknown;
      sketch('xy', () => {
        const e = ellipse([0, 0], 10, 5);
        f1 = fix(e.center(), [0, 0]);
        f2 = fix(e.center(), [20, 0]);
      });
      render();

      const error = (f1 as SceneObject).getError() ?? (f2 as SceneObject).getError();
      expect(error).toMatch(/cannot be satisfied/i);
    });
  });

  describe("bezier control points", () => {
    it("solves literal control points against other entities", () => {
      let bz: unknown;
      sketch('xy', () => {
        const l = line([1, -2], [48, 3]);
        fix(l.start(), [0, 0]);
        horizontal(l);
        distance(l.start(), l.end(), 50);
        const b = bezier([47, 4], [75, 30], [103, 2]);
        bz = b;
        coincident(b.start(), l.end());
        fix(b.end(), [100, 0]);
      });
      const scene = render();

      const payload = payloadOf(scene, bz);
      expect(payload.startPoint[0]).toBeCloseTo(50, 6);
      expect(payload.startPoint[1]).toBeCloseTo(0, 6);
      const end = payload.resolvedPoints[payload.resolvedPoints.length - 1];
      expect(end[0]).toBeCloseTo(100, 6);
      expect(end[1]).toBeCloseTo(0, 6);
      // The free middle control point stays at its guess.
      expect(payload.resolvedPoints[0]).toEqual([75, 30]);
      // Join fields: one anchor record per literal control point.
      expect(payload.anchors).toHaveLength(3);
      expect(payload.anchors[0]).toMatchObject({ pointIndex: 0, guess: { x: 47, y: 4 } });
    });

    it("rides another entity's point when a control point is an accessor", () => {
      let bz: unknown;
      sketch('xy', () => {
        const l = line([1, -2], [48, 3]);
        fix(l.start(), [0, 0]);
        horizontal(l);
        distance(l.start(), l.end(), 50);
        bz = bezier(l.end(), [75, 30], [100, 0]);
      });
      const scene = render();

      const payload = payloadOf(scene, bz);
      // The start follows the solved line end — no anchor entity of its own.
      expect(payload.startPoint[0]).toBeCloseTo(50, 6);
      expect(payload.startPoint[1]).toBeCloseTo(0, 6);
      expect(payload.anchors).toHaveLength(2);
      expect(payload.anchors.map((a: any) => a.pointIndex)).toEqual([1, 2]);
    });

    it("constrains through point(i) on a middle control point", () => {
      let bz: unknown;
      sketch('xy', () => {
        const c = circle([60, 42], 10);
        fix(c.center(), [60, 40]);
        const b = bezier([0, 0], [50, 50], [100, 0]);
        bz = b;
        coincident(b.point(1), c.center());
      });
      const scene = render();

      const payload = payloadOf(scene, bz);
      expect(payload.resolvedPoints[0][0]).toBeCloseTo(60, 6);
      expect(payload.resolvedPoints[0][1]).toBeCloseTo(40, 6);
    });
  });

  describe("text anchor", () => {
    it("keeps an unconstrained .at() anchor where the literal put it", () => {
      let t: unknown;
      sketch('xy', () => {
        t = text('I').size(10).at([5, 7]);
      });
      const scene = render();

      const payload = payloadOf(scene, t);
      expect(payload.anchor).toEqual({ x: 5, y: 7 });
      expect(payload.guess).toEqual({ anchor: { x: 5, y: 7 } });
      expect(payload.entityId).toBeGreaterThanOrEqual(0);

      // Baseline sits at the anchor: the glyph box starts near (5, 7).
      const bbox = getBoundingBoxOfShapes((t as SceneObject).getShapes());
      expect(bbox.minX).toBeGreaterThan(4);
      expect(bbox.minX).toBeLessThan(11);
      expect(bbox.minY).toBeGreaterThan(6);
      expect(bbox.minY).toBeLessThan(10);
    });

    it("solves the anchor onto a constrained point", () => {
      let t: unknown;
      sketch('xy', () => {
        const c = circle([58, 43], 10);
        fix(c.center(), [60, 40]);
        const tx = text('I').size(10);
        t = tx;
        coincident(tx.anchor(), c.center());
      });
      const scene = render();

      const payload = payloadOf(scene, t);
      expect(payload.anchor.x).toBeCloseTo(60, 6);
      expect(payload.anchor.y).toBeCloseTo(40, 6);

      const bbox = getBoundingBoxOfShapes((t as SceneObject).getShapes());
      expect(bbox.minX).toBeGreaterThan(59);
      expect(bbox.minX).toBeLessThan(66);
      expect(bbox.minY).toBeGreaterThan(39);
      expect(bbox.minY).toBeLessThan(43);
    });

    it("refuses .anchor() on text following a path", () => {
      sketch('xy', () => {
        const l = line([0, 0], [100, 0]);
        const t = text('Hi', l);
        expect(() => t.anchor()).toThrow(/no anchor point/);
      });
      render();
    });

    it("serializes the derived tint join: bezier sources and path-text sources", () => {
      let l: unknown;
      let bz: unknown;
      let t: unknown;
      sketch('xy', () => {
        const li = line([0, 0], [50, 0]).guide();
        l = li;
        const b = bezier(li.end(), [75, 30], [100, 0]);
        bz = b;
        t = text('Hi', b as any);
      });
      const scene = render();

      const linePayload = payloadOf(scene, l);
      const bzPayload = payloadOf(scene, bz);
      // The curve vouches through the line's entity (accessor-valued start)
      // plus its two literal control points' anchors.
      expect(bzPayload.sourcesSolved).toBe(true);
      expect(bzPayload.sourceEntities).toContain(linePayload.entityId);
      expect(bzPayload.sourceEntities).toHaveLength(3);
      // Path text vouches through whatever its path vouches through.
      const textPayload = payloadOf(scene, t);
      expect(textPayload.sourcesSolved).toBe(true);
      expect(textPayload.sourceEntities).toEqual(bzPayload.sourceEntities);
    });

    it("constrains anchors between two text statements (h/v alignment)", () => {
      let t2: unknown;
      sketch('xy', () => {
        const a = text('A').at([10, 20]);
        const b = text('B').at([32, 24]);
        t2 = b;
        fix(a.anchor());
        horizontal(a.anchor(), b.anchor());
        vertical(a.anchor(), b.anchor());
      });
      const scene = render();

      const payload = payloadOf(scene, t2);
      expect(payload.anchor.x).toBeCloseTo(10, 6);
      expect(payload.anchor.y).toBeCloseTo(20, 6);
    });
  });
});
