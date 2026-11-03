// Named frames: a feature class declares them (`Feature.with(params, { frames
// })`), its build sets them (`this.setFrames()`), and a model reads one back
// as a plane with `feature.frame(name)` — a connector() source in a part
// body and a plane() input. The frames move with a repeat's copy, as the
// solids do.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { Scene } from "../../rendering/scene.js";
import part from "../../core/part.js";
import plane from "../../core/plane.js";
import connector from "../../core/connector.js";
import repeat from "../../core/repeat.js";
import { Part } from "../../features/part.js";
import { Connector } from "../../features/connector.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { Feature, defineFeature } from "../../sdk/index.js";
import { Primitives, type Shape } from "../../sdk/kernel.js";
import { Plane, Point, Vector3d } from "../../math/index.js";
import { defineSpur, type SpurFeature } from "../fixtures/custom-features/spur.js";

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function connectorNamed(scene: Scene, name: string): Connector {
  const found = scene.getAllSceneObjects().find(o => o instanceof Connector && o.connectorName === name);
  if (!found) {
    throw new Error(`no connector named ${name}`);
  }
  return found as Connector;
}

const near = (point: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
  expect(point.x).toBeCloseTo(x, 6);
  expect(point.y).toBeCloseTo(y, 6);
  expect(point.z).toBeCloseTo(z, 6);
};

/** A tool whose build sets `frames` as given — the shapes a test asks for. */
function framedTool(frames: object, set: (feature: { setFrames(frames: unknown): void }) => void) {
  class Framed extends Feature.with({ size: { type: 'length', default: 2 } }, { frames: frames as never }) {
    static id = 'acme.framed';
    buildTool(): Shape[] {
      set(this as unknown as { setFrames(frames: unknown): void });
      return [Primitives.makeCylinder(this.values.size, 1)];
    }
  }
  return defineFeature(Framed, { label: 'Framed', group: 'create', call: [{ size: 'size' }] }) as unknown as (options?: { size?: number }) => SceneObject;
}

describe("declaring frames", () => {
  setupOC();

  it("carries the declarations as static frames, beside the buckets", () => {
    const { Spur } = defineSpur();
    expect(Spur.frames).toEqual({ axis: { label: 'Gear axis' } });
    expect(Spur.buckets).toEqual({});
  });

  it("lists frames among Feature.with()'s options", () => {
    expect(() => Feature.with({}, { frame: {} } as never)).toThrow("Feature.with(): unknown option 'frame' — the options are: buckets, frames");
  });

  it("refuses a name that can't be a connector's, a declaration that is not an object, and an unknown field", () => {
    expect(() => Feature.with({}, { frames: { 'mount-face': {} } } as never))
      .toThrow("Feature.with(): the frame name 'mount-face' is not an identifier — a frame becomes a connector of its name, such as axis or mountFace");
    expect(() => Feature.with({}, { frames: { axis: true } } as never))
      .toThrow("Feature.with(): frame 'axis' is declared with an object — {} or { label } — got true");
    expect(() => Feature.with({}, { frames: { axis: { normal: 'z' } } } as never))
      .toThrow("Feature.with(): frame 'axis': unknown field 'normal' — a frame declares only its label");
    expect(() => Feature.with({}, { frames: [] } as never))
      .toThrow("Feature.with(): 'frames' must be an object of the feature's frames by name, such as { axis: {}, mount: { label: 'Mounting face' } } — got a list");
  });

  it("refuses frames in a feature's metadata: the class declares them", () => {
    class Plain extends Feature.with({ size: { type: 'length', default: 1 } }) {
      static id = 'acme.plain';
      buildTool(): Shape[] {
        return [];
      }
    }
    expect(() => defineFeature(Plain, { label: 'Plain', group: 'create', call: [{ size: 'size' }], frames: {} } as never))
      .toThrow("defineFeature(Plain): leave 'frames' out — declare frames on the class: Feature.with(params, { frames })");
  });
});

describe("reading a frame", () => {
  setupOC();

  it("refuses a frame the class doesn't declare where it is asked for", () => {
    const { spur } = defineSpur();
    const g = spur();
    expect(() => (g as unknown as { frame(name: string): unknown }).frame('hub'))
      .toThrow("acme.spur: 'hub' is not a frame of the feature — its frames are axis");
  });

  it("is a connector source in a part body: the connector stands on the frame the build set", () => {
    const { spur } = defineSpur();
    part("Wheel", () => {
      const base = connector("base", plane("xy", 5));
      const g = spur(base, { teeth: 20 });
      connector("axis", g.frame("axis"));
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const axis = connectorNamed(scene, "axis");
    expect(axis.getParent()).toBeInstanceOf(Part);
    near(axis.getFrame().origin, 0, 0, 5);
    near(axis.getFrame().normal, 0, 0, 1);
  });

  it("is a plane() input", () => {
    const { spur } = defineSpur();
    const g = spur(undefined, { width: 4 }) as SpurFeature;
    const p = plane(g.frame("axis"), 7) as unknown as PlaneObjectBase;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    near(p.getPlane().origin, 0, 0, 7);
  });

  it("is no timeline row of its own and draws nothing", () => {
    const { spur } = defineSpur();
    const g = spur() as SpurFeature;
    const frame = g.frame("axis") as unknown as SceneObject;
    part("Wheel", () => {
      connector("axis", frame as never);
    });
    render();

    expect(frame.isInternal()).toBe(true);
    expect(frame.isLazy()).toBe(true);
    expect(frame.getShapes({ excludeMeta: false })).toEqual([]);
  });

  it("moves with a repeat's copy, as the solids do", () => {
    const { spur } = defineSpur();
    const g = spur() as unknown as SceneObject;
    const r = repeat("linear", "x", { count: 2, offset: 50 }, g) as unknown as { instance(k: number): { frame(name: string): SceneObject } };
    const copyAxis = plane(r.instance(1).frame("axis")) as unknown as PlaneObjectBase;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    near(copyAxis.getPlane().origin, 50, 0, 0);
    near(copyAxis.getPlane().normal, 0, 0, 1);
  });

  it("reports a frame the build never set on the reader's row", () => {
    const framed = framedTool({ axis: {}, top: {} }, f => f.setFrames({ axis: Plane.XY() }));
    const f = framed() as unknown as { frame(name: string): unknown };
    const top = plane(f.frame("top") as never) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene).map(e => e.split(": ").slice(1).join(": ")))
      .toContain("acme.framed: its build set no frame 'top' — set it with this.setFrames({ top: plane })");
    expect(top.getError()).not.toBeNull();
  });
});

describe("setFrames()", () => {
  setupOC();

  it("refuses a name the class doesn't declare, and a value that is not a plane, as the feature's build error", () => {
    const unknown = framedTool({ axis: {} }, f => f.setFrames({ axle: Plane.XY() }));
    const notPlane = framedTool({ axis: {} }, f => f.setFrames({ axis: new Point(0, 0, 0) }));
    const a = unknown();
    const b = notPlane();
    render();

    expect(a.getError()).toBe("acme.framed: setFrames() 'axle' is not a frame of the feature — its frames are axis");
    expect(b.getError()).toBe("acme.framed: setFrames() axis must be a plane (a Plane: origin, X direction and normal), got an object");
  });

  it("accumulates calls and keeps the last plane of a name", () => {
    const tilted = new Plane(new Point(1, 2, 3), Vector3d.unitX(), Vector3d.unitY().multiply(-1));
    const framed = framedTool({ axis: {}, side: {} }, f => {
      f.setFrames({ axis: Plane.XY() });
      f.setFrames({ side: tilted });
      f.setFrames({ axis: tilted });
    });
    const f = framed() as unknown as { frame(name: string): unknown };
    const axis = plane(f.frame("axis") as never) as unknown as PlaneObjectBase;
    const side = plane(f.frame("side") as never) as unknown as PlaneObjectBase;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    near(axis.getPlane().origin, 1, 2, 3);
    near(side.getPlane().normal, 0, -1, 0);
  });
});
