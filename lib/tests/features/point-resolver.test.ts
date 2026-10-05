import { describe, expect, it } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import copy from "../../core/copy.js";
import mirror from "../../core/mirror.js";
import { line, circle, bezier, text, project, xAxis, yAxis } from "../../core/2d/index.js";
import { rect } from "../../core/shapes/index.js";
import { fix } from "../../core/constraints/index.js";
import { PointResolver } from "../../features/point-resolver.js";
import { frameFromSource } from "../../features/connector-frame.js";
import { Point, Point2D } from "../../math/point.js";
import { Sketch } from "../../features/2d/sketch.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";

describe('sketch points in world coordinates', () => {
  setupOC();

  it('keeps the deprecated regions alias on the same export object', () => {
    const s = sketch('yz', () => ({ segment: line([2, 3], [8, 3]) }));
    expect(s.regions).toBe(s.geometries);
    expect(Object.getOwnPropertyDescriptor(s, 'regions')?.get).toBeTypeOf('function');
    expect(s.geometries.segment.start().asPoint2D()).toEqual(new Point2D(2, 3));
  });

  it('reads solved positions even after a point was read before the solve', () => {
    const s = sketch(plane('yz', { offset: 20 }), () => {
      const segment = line([2, 3], [8, 3]);
      const start = segment.start();
      expect(start.asPoint2D()).toEqual(new Point2D(2, 3));
      // Prime the lazy shape cache as well as the local point accessor.
      start.getShapes();
      fix(start, [5, 7]);
      return { start };
    });
    render();
    expect(s.geometries.start.asPoint2D().distanceTo(new Point2D(5, 7))).toBeLessThan(1e-6);
    const world = PointResolver.toWorld(s.geometries.start);
    expect(world.distanceTo(new Point(20, 5, 7))).toBeLessThan(1e-6);
    expect(frameFromSource(s.geometries.start).origin.distanceTo(world)).toBeLessThan(1e-6);
  });

  it('resolves a sketch point as a displacement without the plane origin', () => {
    const s = sketch(plane('yz', { offset: 20 }), () => {
      const segment = line([2, 3], [8, 3]);
      fix(segment.start(), [5, 7]);
      return { start: segment.start() };
    });
    render();
    // Position: the offset plane's origin plus the in-plane coordinates.
    expect(PointResolver.toWorld(s.geometries.start).distanceTo(new Point(20, 5, 7))).toBeLessThan(1e-6);
    // Displacement: the same in-plane coordinates, turned into world axes only.
    expect(PointResolver.toWorldVector(s.geometries.start).distanceTo(new Point(0, 5, 7))).toBeLessThan(1e-6);
    expect(PointResolver.toWorldVector([1, 2, 3])).toEqual(new Point(1, 2, 3));
  });

  it('lifts bezier, text, macro, copy and mirror point references', () => {
    const s = sketch(plane('yz', { offset: 20 }), () => {
      const c = circle([10, 0], 6);
      const cp = copy('linear', xAxis(), { count: 2, offset: 30 }, c);
      const m = mirror(yAxis(), c);
      const b = bezier([0, 0], [5, 10], [10, 0]);
      const t = text('A').at([0, 20]);
      const r = rect([0, 30], 10, 5);
      return { b: b.point(1), t: t.anchor(), r: r.bottom().start(), cp: cp.instance(1).center(), m: m.instance(c).center() };
    });
    const scene = render();
    expect(scene.getRenderedObjects().filter(object => object.hasError).map(object => object.errorMessage)).toEqual([]);
    for (const [key, local] of Object.entries({ b: [5, 10], t: [0, 20], r: [0, 30], cp: [40, 0], m: [-10, 0] })) {
      const ref = s.geometries[key as keyof typeof s.geometries];
      expect(PointResolver.toWorld(ref).distanceTo(new Point(20, local[0], local[1])), key).toBeLessThan(1e-6);
    }
  });

  it('lifts projected point references through their owning sketch plane', () => {
    const source = sketch(plane('yz', { offset: 20 }), () => ({ l: line([3, 4], [12, 4]) }));
    const destination = sketch(plane('yz', { offset: 50 }), () => ({ p: project(source.geometries.l) }));
    render();
    expect((destination as unknown as Sketch).getError()).toBeNull();
    const world = PointResolver.toWorld(destination.geometries.p.ref(0).start());
    expect(world.distanceTo(new Point(50, 3, 4))).toBeLessThan(1e-6);
  });

  it('keeps solved macro, copy and mirror points coherent with cached sketch snapshots', () => {
    const declare = () => sketch(plane('yz', { offset: 20 }), () => {
      const c = circle([10, 0], 6);
      const cp = copy('linear', xAxis(), { count: 2, offset: 30 }, c);
      const m = mirror(yAxis(), c);
      const r = rect([0, 30], 10, 5);
      fix(c.center(), [15, 5]);
      fix(r.bottom().start(), [10, 30]);
      return { c, cp, m, r };
    });
    const points = (s: ReturnType<typeof declare>) => [
      s.geometries.c.center(), s.geometries.cp.instance(1).center(),
      s.geometries.m.instance(s.geometries.c).center(), s.geometries.r.bottom().start(),
    ];
    const original = declare();
    const previous = render();
    const expected = points(original).map(p => PointResolver.toWorld(p));
    const scene = getSceneManager().startScene();
    const cached = declare();
    SceneCompare.compare(previous, scene);
    render();
    for (const [i, p] of points(cached).entries()) {
      expect(PointResolver.toWorld(p).distanceTo(expected[i])).toBeLessThan(1e-6);
    }
    expect((cached.geometries.r as unknown as { serialize(): unknown }).serialize())
      .toEqual((original.geometries.r as unknown as { serialize(): unknown }).serialize());
  });

  it('leaves coordinate literals in world space and rejects non-finite coordinates', () => {
    for (const p of [new Point(1, 2, 3), [1, 2, 3] as [number, number, number], { x: 1, y: 2, z: 3 }]) {
      expect(PointResolver.toWorld(p)).toEqual(new Point(1, 2, 3));
    }
    expect(() => PointResolver.toWorld([Infinity, 0, 0])).toThrow(/finite/);
  });
});
