import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { circle, ellipse, line, arc, origin, xAxis } from "../../../core/2d/index.js";
import {
  coincident, concentric, diameter, distance, fix, horizontal, radius, tangent, vertical, equal,
} from "../../../core/constraints/index.js";
import { Ellipse } from "../../../features/2d/ellipse.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Scene } from "../../../rendering/scene.js";
import { Solid } from "../../../common/solid.js";
import { ShapeOps } from "../../../oc/shape-ops.js";

function payloadOf(scene: Scene, obj: unknown) {
  return scene.getRenderedObject(obj as SceneObject).object;
}

describe("ellipse", () => {
  setupOC();

  describe("in sketch", () => {
    it("creates an ellipse with rx along X and ry along Y", () => {
      sketch("xy", () => {
        ellipse([0, 0], 50, 30);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(60, 0);
    });

    it("handles ry > rx (axis-swap path)", () => {
      sketch("xy", () => {
        ellipse([0, 0], 30, 50);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(100, 0);
    });

    it("creates an ellipse at a given center", () => {
      sketch("xy", () => {
        ellipse([50, 30], 40, 20);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const bbox = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(bbox.centerX).toBeCloseTo(50, 0);
      expect(bbox.centerY).toBeCloseTo(30, 0);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(80, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(40, 0);
    });

    it("falls through to a circle when rx == ry", () => {
      sketch("xy", () => {
        ellipse([0, 0], 25, 25);
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(50, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(50, 0);
    });

    it("rejects zero or negative radii", () => {
      let zeroEllipse: Ellipse | undefined;
      sketch("xy", () => {
        zeroEllipse = ellipse([0, 0], 0, 30) as Ellipse;
      });
      render();
      expect(zeroEllipse?.getError()).toMatch(/positive/i);

      let negEllipse: Ellipse | undefined;
      sketch("xy", () => {
        negEllipse = ellipse([0, 0], -10, 5) as Ellipse;
      });
      render();
      expect(negEllipse?.getError()).toMatch(/positive/i);
    });
  });

  describe("as a solver entity", () => {
    it("registers as an ellipse entity with every literal a guess", () => {
      let el: unknown;
      const sk = sketch("xy", () => {
        el = ellipse([10, 5], 30, 15, 20);
      }) as unknown as Sketch;
      const scene = render();

      const sketchPayload = payloadOf(scene, sk);
      const entities = sketchPayload.solver.entities.filter((e: any) => e.id >= 0);
      expect(entities).toHaveLength(1);
      expect(entities[0].kind).toBe("ellipse");
      // Center, rotation and both semi-radii free: 5 DOF, like a circle's 3.
      expect(sketchPayload.solver.dof).toBe(5);

      const payload = payloadOf(scene, el);
      expect(payload.rx).toBe(30);
      expect(payload.ry).toBe(15);
      expect(payload.rotation).toBeCloseTo(20, 9);
      expect(payload.guess).toEqual({ center: { x: 10, y: 5 }, rx: 30, ry: 15, rotation: 20 });
    });

    it("builds the rotated outline from the rotation argument", () => {
      sketch("xy", () => {
        const e = ellipse([0, 0], 50, 30, 90);
        coincident(e.center(), origin());
        // Undimensioned radii keep their guesses.
      });
      const e3d = extrude(10) as ExtrudeBase;
      render();

      // RX (50) now runs along y.
      const bbox = ShapeOps.getBoundingBox(e3d.getShapes()[0] as Solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(60, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(100, 0);
    });

    it("horizontal() and vertical() orient the RX axis", () => {
      let h: unknown;
      let v: unknown;
      const sk = sketch("xy", () => {
        const a = ellipse([0, 0], 50, 30, 25);
        coincident(a.center(), origin());
        horizontal(a);
        radius(a, 50, 'x');
        radius(a, 30, 'y');
        h = a;
        const b = ellipse([200, 0], 50, 30, -25);
        fix(b.center(), [200, 0]);
        vertical(b);
        radius(b, 50, 'x');
        radius(b, 30, 'y');
        v = b;
      }) as unknown as Sketch;
      const scene = render();

      expect(payloadOf(scene, sk).solver.dof).toBe(0);
      expect(Math.abs(payloadOf(scene, h).rotation) % 180).toBeCloseTo(0, 6);
      expect(Math.abs(payloadOf(scene, v).rotation) % 180).toBeCloseTo(90, 6);
    });

    it("concentric() shares the center with circles, arcs and ellipses", () => {
      let c: unknown;
      let a: unknown;
      let e2: unknown;
      sketch("xy", () => {
        const e = ellipse([0, 0], 50, 30);
        coincident(e.center(), origin());
        horizontal(e);
        const bore = circle([20, 10], 10);
        radius(bore, 5);
        concentric(bore, e);
        c = bore;
        const rim = arc([60, 5], [55, 20], [10, 10]);
        concentric(e, rim);
        a = rim;
        const inner = ellipse([-5, 3], 20, 10);
        horizontal(inner);
        concentric(inner, e);
        e2 = inner;
      });
      const scene = render();

      for (const obj of [c, a, e2]) {
        const center = payloadOf(scene, obj).center;
        expect(center.x).toBeCloseTo(0, 6);
        expect(center.y).toBeCloseTo(0, 6);
      }
    });

    it("tangent() to a line rests the ellipse on the line", () => {
      let el: unknown;
      const sk = sketch("xy", () => {
        const e = ellipse([0, 33], 50, 30);
        horizontal(e);
        radius(e, 50, 'x');
        radius(e, 30, 'y');
        vertical(e.center(), origin());
        tangent(e, xAxis());
        el = e;
      }) as unknown as Sketch;
      const scene = render();

      expect(payloadOf(scene, sk).solver.outcome).toBe("solved");
      expect(payloadOf(scene, sk).solver.dof).toBe(0);
      // RX along x: the half-height is ry = 30.
      expect(payloadOf(scene, el).center.y).toBeCloseTo(30, 6);
    });

    it("tangent() to a circle and a point on the ellipse", () => {
      let bore: unknown;
      let pt: unknown;
      const sk = sketch("xy", () => {
        const e = ellipse([0, 0], 50, 30);
        coincident(e.center(), origin());
        horizontal(e);
        radius(e, 50, 'x');
        radius(e, 30, 'y');
        const c = circle([70, 0], 20);
        radius(c, 10);
        horizontal(c.center(), e.center());
        tangent(c, e);
        bore = c;
        const l = line([60, 0], [60, 40]);
        coincident(l.start(), e);
        vertical(l);
        distance(l.start(), l.end(), 40);
        distance(l.start(), origin(), 30, "x");
        pt = l;
      }) as unknown as Sketch;
      const scene = render();

      const solver = payloadOf(scene, sk).solver;
      expect(solver.outcome).toBe("solved");
      expect(solver.dof).toBe(0);
      // External contact at the RX vertex: centers 50 + 10 apart.
      expect(payloadOf(scene, bore).center.x).toBeCloseTo(60, 5);
      // The line start sits on the ellipse at x = 30: y = 30·√(1 − 0.36).
      const start = payloadOf(scene, pt).start;
      expect(Math.abs(start.y)).toBeCloseTo(30 * Math.sqrt(1 - 0.36), 5);
    });

    it("radius(el, v, axis) resizes a semi-radius; equal() matches two ellipses", () => {
      let el: unknown;
      let twin: unknown;
      sketch("xy", () => {
        const e = ellipse([0, 0], 50, 30);
        coincident(e.center(), origin());
        horizontal(e);
        radius(e, 40, 'x');
        radius(e, 12, 'y');
        el = e;
        const t = ellipse([150, 0], 10, 5, 30);
        equal(t, e);
        twin = t;
      });
      const e3d = extrude(10) as ExtrudeBase;
      const scene = render();

      expect(payloadOf(scene, el).rx).toBeCloseTo(40, 6);
      expect(payloadOf(scene, el).ry).toBeCloseTo(12, 6);
      expect(payloadOf(scene, twin).rx).toBeCloseTo(40, 6);
      expect(payloadOf(scene, twin).ry).toBeCloseTo(12, 6);
      const bbox = ShapeOps.getBoundingBox(e3d.getShapes()[0] as Solid);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(24, 0);
    });

    it("refuses an axis-less radius() on an ellipse, an axis on a circle, and diameter()", () => {
      let r: unknown;
      let c2: unknown;
      let d: unknown;
      sketch("xy", () => {
        const e = ellipse([0, 0], 50, 30);
        const c = circle([100, 0], 20);
        r = radius(e, 40);
        c2 = radius(c, 10, 'x');
        d = diameter(e, 40);
      });
      render();

      expect((r as SceneObject).getError()).toMatch(/needs the axis/);
      expect((c2 as SceneObject).getError()).toMatch(/axis argument/);
      expect((d as SceneObject).getError()).toMatch(/two semi-radii/);
    });

    it("rejects a non-finite rotation argument", () => {
      expect(() => sketch("xy", () => { ellipse([0, 0], 10, 5, Number.NaN); }))
        .toThrow(/rotation must be a finite number/);
    });
  });
});
