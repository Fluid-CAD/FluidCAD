import { describe, expect, it } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import select from "../../core/select.js";
import { edge } from "../../filters/index.js";
import { line } from "../../core/2d/index.js";
import { Loft } from "../../features/loft.js";
import { SceneObject } from "../../common/scene-object.js";
import { Point } from "../../math/point.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { testRect } from "../helpers/profiles.js";
import { countShapes } from "../utils.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";
import { readFileSync } from "node:fs";
import * as core from "../../core/index.js";
import * as constraints from "../../core/constraints/index.js";

function profiles() {
  return [
    sketch('xy', () => testRect(40, 40)),
    sketch(plane('xy', { offset: 60 }), () => testRect(40, 40)),
  ] as const;
}

function expectEdge(feature: Loft, points: Point[]): void {
  expect(feature.getError()).toBeNull();
  expect(feature.getShapes()).toHaveLength(1);
  const solid = feature.getShapes()[0];
  expect(ShapeValidator.validate(solid.getShape()).findings).toEqual([]);
  expect(Explorer.findEdgesWrapped(solid).some(edge =>
    points.every(point => EdgeOps.distancePointToEdge(point, edge) < 1e-6),
  )).toBe(true);
}

describe('loft connections API', () => {
  setupOC();

  it('connects exported sketch vertices with repeatable calls', () => {
    const [a, b] = profiles();
    const result = loft(a, b)
      .connect(a.geometries.b.start(), b.geometries.r.start())
      .connect(a.geometries.r.start(), b.geometries.t.start()) as Loft;
    render();
    expectEdge(result, [new Point(0, 0, 0), new Point(40, 0, 60)]);
    expectEdge(result, [new Point(40, 0, 0), new Point(40, 40, 60)]);
    expect(result.serialize().connections).toHaveLength(2);
  });

  it('lifts exported points from offset non-XY planes', () => {
    const a = sketch(plane('yz', { offset: 10 }), () => testRect(40, 40));
    const b = sketch(plane('yz', { offset: 60 }), () => testRect(40, 40));
    const result = loft(a, b).connect(a.geometries.b.start(), b.geometries.b.start()) as Loft;
    render();
    expectEdge(result, [new Point(10, 0, 0), new Point(60, 0, 0)]);
  });

  it('accepts mixed coordinate forms and snapshots their values', () => {
    const [a, b] = profiles();
    const point: [number, number, number] = [0, 0, 0];
    const result = loft(a, b).connect(point, { x: 0, y: 0, z: 60 }) as Loft;
    point[0] = 100;
    render();
    expectEdge(result, [new Point(0, 0, 0), new Point(0, 0, 60)]);
    expect(result.serialize().connections).toEqual([[[0, 0, 0], [0, 0, 60]]]);
  });

  it('connects a selection declared before the loft', () => {
    const base = sketch('xy', () => testRect(40, 40));
    const e = extrude(20, base);
    const top = sketch(plane('xy', { offset: 80 }), () => testRect(40, 40));
    const sel = select(edge().onPlane('xy', 20).nearest('y'));
    const result = loft(e.endFaces(), top).connect(sel.start(), top.geometries.b.start()).new() as Loft;
    render();
    expect(result.getError()).toBeNull();
    expect(result.getShapes()).toHaveLength(1);
  });

  it('consumes the selections its connection points are anchored to', () => {
    const base = sketch('xy', () => testRect(40, 40));
    const e = extrude(20, base);
    const top = sketch(plane('xy', { offset: 80 }), () => testRect(40, 40));
    const sel = select(edge().onPlane('xy', 20).nearest('y'));
    const kept = select(edge().onPlane('xy', 20).nearest('y')).reusable();
    const result = loft(e.endFaces(), top)
      .connect(sel.start(), top.geometries.b.start())
      .connect(kept.end(), top.geometries.r.start()).new() as Loft;
    render();
    expect(result.getError()).toBeNull();
    expect(result.getShapes()).toHaveLength(1);
    expect((sel as unknown as SceneObject).getShapes()).toHaveLength(0);
    expect((kept as unknown as SceneObject).getShapes()).toHaveLength(1);
  });

  it('reports a selection written inside .connect() as created after the loft', () => {
    const base = sketch('xy', () => testRect(40, 40));
    const e = extrude(20, base);
    const top = sketch(plane('xy', { offset: 80 }), () => testRect(40, 40));
    const result = loft(e.endFaces(), top)
      .connect(select(edge().onPlane('xy', 20).nearest('y')).start(), top.geometries.b.start()).new() as Loft;
    render();
    expect(result.getError()).toMatch(/loft\(\) uses a select\(\) that runs after it/);
  });

  it('connects solid edge anchors to exported sketch points', () => {
    const base = sketch('xy', () => testRect(40, 40));
    const e = extrude(20, base);
    const top = sketch(plane('xy', { offset: 80 }), () => testRect(40, 40));
    const anchor = e.endEdges(0).start();
    const result = loft(e.endFaces(), top).connect(anchor, top.geometries.b.start()).new() as Loft;
    render();
    // The anchor is consumed by the loft; its resolved position lives on the feature.
    expectEdge(result, [result.getConnectionPoints()[0][0], new Point(0, 0, 80)]);
    expect(result.getConnectionPoints()[0][0].z).toBeCloseTo(20);
  });

  it.each(['references', 'literals', 'lazy coordinates'])('repeats a connected loft using %s', kind => {
    const [a, b] = profiles();
    const feature = (kind === 'references'
      ? loft(a, b).connect(a.geometries.b.start(), b.geometries.b.start())
      : kind === 'literals' ? loft(a, b).connect([0, 0, 0], [0, 0, 60])
      : loft(a, b).connect(LazyVertex.fromVertex(Vertex.fromPoint(new Point(0, 0, 0))),
        LazyVertex.fromVertex(Vertex.fromPoint(new Point(0, 0, 60))))).new() as Loft;
    const pattern = repeat('linear', 'x', { count: 3, offset: 100 }, feature) as unknown as SceneObject;
    const scene = render();
    expect(feature.getError()).toBeNull();
    expect(pattern.getError()).toBeNull();
    expect(scene.getAllSceneObjects().filter(object => object.getError()).map(object => object.getError())).toEqual([]);
    expect(countShapes(scene)).toBe(3);
  });

  it('tracks point dependencies and remaps them when copied', () => {
    const [a, b] = profiles();
    const start = a.geometries.b.start();
    const end = b.geometries.b.start();
    const feature = loft(a, b).connect(start, end) as Loft;
    expect(feature.getDependencies()).toEqual(expect.arrayContaining([start, end]));
    const replacement = b.geometries.r.start();
    const copy = feature.createCopy(new Map([[end, replacement]])) as Loft;
    expect(copy.getDependencies()).toContain(replacement);
    expect(copy.getDependencies()).not.toContain(end);
    expect(feature.compareTo(copy)).toBe(false);
    expect(feature.compareTo(feature.createCopy(new Map()) as Loft)).toBe(true);
  });

  it('compares connection count, vertices and literal values', () => {
    const [a, b] = profiles();
    const feature = new Loft(a as unknown as SceneObject, b as unknown as SceneObject).connect([0, 0, 0], [0, 0, 60]);
    expect(feature.compareTo(new Loft(a as unknown as SceneObject, b as unknown as SceneObject))).toBe(false);
    expect(feature.compareTo(new Loft(a as unknown as SceneObject, b as unknown as SceneObject).connect([0, 0, 0], [40, 0, 60]))).toBe(false);
    expect(feature.compareTo(new Loft(a as unknown as SceneObject, b as unknown as SceneObject).connect(new Point(0, 0, 0), [0, 0, 60]))).toBe(true);
  });

  it.each([
    ['arity', /connect expects 2 points/],
    ['on edge', /lies on an edge, not on a vertex/],
    ['off profile', /off its profile.*gap/],
    ['duplicate', /same vertex on profile/],
    ['crossing', /connections 2 and 3 cross/],
    ['thin', /connections cannot yet be combined with thin/],
    ['guides', /connections cannot yet be combined with guides/],
    ['nonfinite', /finite numbers/],
  ])('surfaces %s errors through getError without throwing from render', (kind, message) => {
    const [a, b] = profiles();
    const feature = loft(a, b) as Loft;
    const setups: Record<string, () => void> = {
      'arity': () => feature.connect([0, 0, 0]),
      'on edge': () => feature.connect([0, 0, 0], [20, 0, 60]),
      'off profile': () => feature.connect([0, 0, 0], [0, -10, 60]),
      'nonfinite': () => feature.connect([0, 0, 0], [NaN, 0, 60]),
      'duplicate': () => feature.connect([0, 0, 0], [0, 0, 60]).connect([40, 0, 0], [0, 0, 60]),
      'crossing': () => feature.connect([0, 0, 0], [0, 0, 60])
        .connect([40, 0, 0], [40, 40, 60]).connect([40, 40, 0], [40, 0, 60]),
      'thin': () => feature.connect([0, 0, 0], [0, 0, 60]).thin(2),
      'guides': () => feature.connect([0, 0, 0], [0, 0, 60]).guides(a as unknown as SceneObject),
    };
    setups[kind]();
    expect(() => render()).not.toThrow();
    expect(feature.getError()).toMatch(message);
  });

  it('reports multi-region and open profiles as feature errors', () => {
    const a = sketch('xy', () => {
      testRect(20, 20);
      testRect(20, 20, { at: [40, 0] });
    });
    const b = sketch(plane('xy', { offset: 60 }), () => testRect(20, 20));
    const open = sketch(plane('xy', { offset: 90 }), () => line([0, 0], [20, 0]));
    const multiple = loft(a, b).connect([0, 0, 0], [0, 0, 60]) as Loft;
    const unclosed = loft(b, open).connect([0, 0, 60], [0, 0, 90]) as Loft;
    expect(() => render()).not.toThrow();
    expect(multiple.getError()).toMatch(/exactly one region per profile/);
    expect(unclosed.getError()).toMatch(/closed.*profiles/);
  });

  it('builds the documented square-to-round transition with valid topology', () => {
    const source = readFileSync(new URL('../../../website/docs/3d-operations/_examples/loft-connections.js', import.meta.url), 'utf8');
    const globals = { ...core, ...constraints };
    new Function(...Object.keys(globals), source.replace(/^import .* from .*;$/gm, ''))(...Object.values(globals));
    const scene = render();
    expect(scene.getRenderedObjects().filter(object => object.hasError).map(object => object.errorMessage)).toEqual([]);
    const feature = scene.getAllSceneObjects().find(object => object instanceof Loft) as Loft;
    expect(feature.getShapes()).toHaveLength(1);
    expect(ShapeValidator.validate(feature.getShapes()[0].getShape()).findings).toEqual([]);
    expect(feature.serialize().connectionPoints).toHaveLength(4);
  });
});
