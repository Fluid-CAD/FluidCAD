import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import axis from "../../core/axis.js";
import plane from "../../core/plane.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeOps as InternalShapeOps } from "../../oc/shape-ops.js";
import { Matrix4, Vector3d } from "../../math/index.js";
import { Feature, parseCall, registerBuilder, type FeatureMeta, type ISceneObject } from "../../sdk/index.js";
import { Primitives, ShapeOps, type Shape } from "../../sdk/kernel.js";

// An axis value may name a world axis and a plane value an origin plane —
// `'z'`, `'xy'` — the way the built-ins take them and what the feature
// dialog writes for one picked in the viewport. The builder turns each into
// the scene object `axis()` / `plane()` would build, and the feature reads
// every axis and plane one way: axisOf(), planeOf().

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** A dowel pin: a cylinder of `length` along the picked axis, from its origin. */
class Pin extends Feature<{ along: ISceneObject; length: number }> {
  static id = 'acme.pin';

  buildTool(): Shape[] {
    const along = this.axisOf(this.values.along);
    const d = along.direction.normalize();
    const helper = Math.abs(d.z) < 0.9 ? new Vector3d(0, 0, 1) : new Vector3d(1, 0, 0);
    const x = helper.cross(d).normalize();
    const pin = Primitives.makeCylinder(1, this.values.length);
    const placed = ShapeOps.transform(pin, Matrix4.fromBasis(x, d.cross(x), d, along.origin));
    pin.dispose();
    return [placed];
  }
}

/** A washer-like disc lying on the picked plane. */
class Disc extends Feature<{ on: ISceneObject }> {
  static id = 'acme.disc';

  buildTool(): Shape[] {
    const on = this.planeOf(this.values.on);
    const disc = Primitives.makeCylinder(5, 1);
    const placed = ShapeOps.transform(disc, Matrix4.fromBasis(on.xDirection, on.yDirection, on.normal, on.origin));
    disc.dispose();
    return [placed];
  }
}

const pinMeta: FeatureMeta = {
  class: Pin,
  label: 'Pin',
  group: 'create',
  kind: 'tool',
  params: {
    along: { picker: 'axis', label: 'Along' },
    length: { type: 'length', default: 8 },
  },
  call: ['along', { length: 'length' }],
};

const discMeta: FeatureMeta = {
  class: Disc,
  label: 'Disc',
  group: 'create',
  kind: 'tool',
  params: { on: { picker: 'plane', label: 'On plane' } },
  call: ['on'],
};

const pin = registerBuilder(context =>
  (...args: unknown[]) => new Pin(parseCall(pinMeta, args) as never).addTo(context), { feature: pinMeta }) as
  (along: unknown, options?: { length?: number }) => Pin;
const disc = registerBuilder(context =>
  (...args: unknown[]) => new Disc(parseCall(discMeta, args) as never).addTo(context), { feature: discMeta }) as
  (on: unknown) => Disc;

function boundsOf(feature: SceneObject) {
  const solids = feature.getShapes(undefined, 'solid');
  expect(solids).toHaveLength(1);
  return InternalShapeOps.getExactBoundingBox(solids[0]);
}

describe("world axes and origin planes as picked values", () => {
  setupOC();

  it("builds an axis value from a world axis name, an axis() statement or a resolved axis", () => {
    // Separate bodies, so the second doesn't fuse the first into itself.
    const fromName = (pin('x', { length: 10 }) as unknown as SceneObject).new();
    const fromStatement = (pin(axis('y')) as unknown as SceneObject).new();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const x = boundsOf(fromName);
    expect(x.maxX - x.minX).toBeCloseTo(10, 6);
    expect(x.maxY - x.minY).toBeCloseTo(2, 6);
    const y = boundsOf(fromStatement);
    expect(y.maxY - y.minY).toBeCloseTo(8, 6);
  });

  it("puts the axis a name stands for in the scene, ahead of the feature", () => {
    const feature = pin('z') as unknown as Pin;
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const along = feature.values.along as unknown as SceneObject;
    expect(along.getType()).toBe('axis');
    // It serves the pin's statement alone: no timeline row of its own.
    expect(along.isInternal()).toBe(true);
    const objects = scene.getAllSceneObjects();
    expect(objects.indexOf(along)).toBeGreaterThanOrEqual(0);
    expect(objects.indexOf(along)).toBeLessThan(objects.indexOf(feature as unknown as SceneObject));
  });

  it("builds a plane value from an origin plane name or a plane() statement", () => {
    const onTop = (disc('xy') as unknown as SceneObject).new();
    const onFront = (disc(plane('xz', { offset: 4 })) as unknown as SceneObject).new();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const top = boundsOf(onTop);
    expect(top.maxZ - top.minZ).toBeCloseTo(1, 6);
    const front = boundsOf(onFront);
    expect(front.maxY - front.minY).toBeCloseTo(1, 6);
  });

  it("refuses a name that is no world axis or origin plane, and a datum in the wrong kind of value", () => {
    expect(() => parseCall(pinMeta, ['w'])).toThrow(/'along' must be a scene object \(.*an axis or a world axis\), got 'w'/);
    expect(() => parseCall(pinMeta, ['xy'])).toThrow(/'along' must be/);
    expect(() => parseCall(discMeta, ['z'])).toThrow(/'on' must be a scene object \(.*a plane or an origin plane\), got 'z'/);
  });

  it("refuses to read a value that is no axis as one", () => {
    class Confused extends Feature<{ along: ISceneObject }> {
      static id = 'acme.confused';

      buildTool(): Shape[] {
        this.axisOf(this.values.along);
        return [];
      }
    }
    const confused = registerBuilder(context =>
      (along: ISceneObject) => new Confused({ along }).addTo(context)) as (along: unknown) => SceneObject;
    const feature = confused(plane('xy'));
    render();
    expect(feature.getError()).toMatch(/acme\.confused: a plane is not an axis/);
  });
});
