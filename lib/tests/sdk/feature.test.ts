import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Feature, registerBuilder, type FeatureBuildContext, type ISceneObject, type ISelection } from "../../sdk/index.js";
import { ShapeOps, type Face } from "../../sdk/kernel.js";

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function resolved(selection: ISelection): unknown[] {
  const lazy = selection as unknown as SceneObject;
  lazy.build();
  return lazy.getShapes();
}

/**
 * A modifier: lifts the solids of a feature by `height`, naming the lifted
 * top faces its end faces. It changes the scene's solids itself, so it
 * overrides build().
 */
class Lift extends Feature<{ target: ISceneObject; height: number }> {
  static id = 'acme.lift';

  override build(_ctx: FeatureBuildContext): void {
    const target = this.values.target as unknown as SceneObject;
    const move = Matrix4.fromTranslation(0, 0, this.values.height);
    const lifted = target.getShapes(undefined, 'solid').map(solid => ShapeOps.transform(solid, move));
    target.removeShapes(this);
    this.addShapes(lifted);
    const top = Math.max(...lifted.map(solid => ShapeOps.getExactBoundingBox(solid).maxZ));
    this.setBuckets({
      endFaces: lifted.flatMap(solid => solid.getSubShapes('face') as Face[])
        .filter(f => Math.abs(ShapeOps.getExactBoundingBox(f).minZ - top) < 1e-6),
    });
  }
}

const lift = registerBuilder(context =>
  (target: ISceneObject, height: number) => new Lift({ target, height }).addTo(context));

function box(): SceneObject {
  sketch("xy", () => {
    testRect(20, 10);
  });
  return extrude(5) as unknown as SceneObject;
}

describe("Feature", () => {
  setupOC();

  it("needs a static id", () => {
    class Nameless extends Feature<{ n: number }> {}
    expect(() => new Nameless({ n: 1 })).toThrow(/Nameless needs a static id/);
  });

  it("is constructed from one object of named values", () => {
    expect(() => new Lift(7 as never)).toThrow(/constructed from one object of named values/);
    expect(() => new Lift({ target: [box(), 3] as never, height: 1 })).toThrow(/a list mixing scene objects/);
  });

  it("freezes its own copy of the values", () => {
    const sizes = [1, 2];
    const feature = new (class extends Feature<{ sizes: number[] }> {
      static id = 'acme.sizes';
    })({ sizes });
    sizes.push(3);
    expect(feature.values.sizes).toEqual([1, 2]);
    expect(Object.isFrozen(feature.values)).toBe(true);
  });

  it("compares by id and values, never by class", () => {
    const define = () => class extends Feature<{ n: number; tags: string[] }> {
      static id = 'acme.counter';
    };
    const A = define();
    const B = define();
    const Other = class extends Feature<{ n: number; tags: string[] }> {
      static id = 'acme.other';
    };
    expect(new A({ n: 1, tags: ['x'] }).compareTo(new B({ n: 1, tags: ['x'] }))).toBe(true);
    expect(new A({ n: 1, tags: ['x'] }).compareTo(new B({ n: 2, tags: ['x'] }))).toBe(false);
    expect(new A({ n: 1, tags: ['x'] }).compareTo(new B({ n: 1, tags: ['y'] }))).toBe(false);
    expect(new A({ n: 1, tags: ['x'] }).compareTo(new B({ n: 1 } as never))).toBe(false);
    expect(new A({ n: 1, tags: ['x'] }).compareTo(new Other({ n: 1, tags: ['x'] }))).toBe(false);
  });

  it("serializes its scalars and names its references", () => {
    const target = box();
    const feature = new Lift({ target, height: 4 });
    expect(feature.serialize()).toEqual({
      values: { height: 4 },
      references: { target: { type: target.getType(), id: target.id } },
    });
  });
});

describe("a modifier Feature", () => {
  setupOC();

  it("builds through its own build(), its edge buckets derived from the faces it names", () => {
    const target = box();
    const lifted = lift(target, 3) as unknown as Lift;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(lifted.isTool()).toBe(false);
    expect(target.getShapes()).toEqual([]);
    expect(ShapeOps.getExactBoundingBox(lifted.getShapes()[0]).maxZ).toBeCloseTo(8, 6);
    expect(resolved(lifted.endFaces())).toHaveLength(1);
    expect(resolved(lifted.endEdges())).toHaveLength(4);
  });

  it("depends on its references, and a repeat copies and remaps them", () => {
    const target = box();
    const lifted = lift(target, 3) as unknown as Lift;
    expect(lifted.getDependencies()).toEqual([target]);
    expect(lifted.getCloneDependencies()).toEqual([target]);

    const targetCopy = box();
    const copy = lifted.createCopy(new Map([[target, targetCopy]])) as Lift;
    expect(copy).toBeInstanceOf(Lift);
    expect(copy.values.target).toBe(targetCopy);
    expect(copy.values.height).toBe(3);
  });

  it("keeps the operation the statement chose on a copy", () => {
    const target = box();
    const lifted = (lift(target, 3) as unknown as Lift).new();
    const copy = lifted.createCopy(new Map()) as Lift;
    expect(copy.getOperationMode()).toBe('new');
    expect(copy.getFusionScope()).toBe('none');
  });
});
