// Every statement that takes an axis takes a connector there too — its Z
// axis through its origin — read in one place (resolveAxis over
// ConnectorAxis): revolve, rotate, helix, repeat, copy, axis() and a custom
// feature's axis value. Each builds around `bolt`, and around a copy of it
// (`bolt.instance(1)`), exactly as around the same line written as an
// axis(): the same volume, the same box. A render never throws: every test
// asserts getError().

import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import copy from "../core/copy.js";
import revolve from "../core/revolve.js";
import rotate from "../core/rotate.js";
import helix from "../core/helix.js";
import repeat from "../core/repeat.js";
import axis from "../core/axis.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Scene } from "../rendering/scene.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { ShapeProps } from "../oc/props.js";
import { Connector } from "../features/connector.js";
import { AxisFromConnector } from "../features/axis-from-connector.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { SceneCompare } from "../rendering/scene-compare.js";
import { resolveFeatureSources } from "../selection/feature-sources.js";
import type { SelectionBoundary } from "../selection/types.js";
import { buildFeatureGhost, type FeatureGhostResult } from "../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { Feature, defineFeature } from "../sdk/index.js";
import { Primitives, ShapeOps as KernelShapeOps } from "../sdk/kernel.js";
import { Matrix4, Vector3d } from "../math/index.js";
import type { AxisTransformOptions } from "../math/axis.js";
import { setLocation } from "./selection/pick-helpers.js";

const FILE = "/ws/model.fluid.js";

/** Every object's build error, readable — `[]` when the render is clean. */
function errors(scene: Scene): string[] {
  return scene.getAllSceneObjects()
    .filter(o => o.getError())
    .map(o => `${o.getUniqueType()}: ${o.getError()}`);
}

/** `pin(along, { length })`: a Ø2 pin of `length` along the picked axis, from its origin. */
class Pin extends Feature.with({
  along: { picker: "axis", label: "Along" },
  length: { type: "length", default: 8 },
}) {
  static id = "acme.pin";

  buildTool(): Shape[] {
    const along = this.axisOf(this.values.along);
    const d = along.direction.normalize();
    const helper = Math.abs(d.z) < 0.9 ? new Vector3d(0, 0, 1) : new Vector3d(1, 0, 0);
    const x = helper.cross(d).normalize();
    const pin = Primitives.makeCylinder(1, this.values.length);
    const placed = KernelShapeOps.transform(pin, Matrix4.fromBasis(x, d.cross(x), d, along.origin));
    pin.dispose();
    return [placed];
  }
}
const pin = defineFeature(Pin, { label: "Pin", group: "create", operations: ["add", "new"], call: ["along", { length: "length" }] });

/** What a scene built: one object's solids, measured. */
type Built = { volume: number; box: number[] };

/** The volume and box of `obj`'s solids (or edges, for a wire), rounded so two builds compare. */
function measure(obj: SceneObject): Built {
  const shapes = obj.getShapes().filter(s => s.isSolid() || s.isEdge() || s.isWire());
  expect(shapes.length).toBeGreaterThan(0);
  let volume = 0;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    if (shape.isSolid()) {
      volume += ShapeProps.getProperties(shape.getShape()).volumeMm3;
    }
    const b = ShapeOps.getExactBoundingBox(shape);
    box[0] = Math.min(box[0], b.minX);
    box[1] = Math.min(box[1], b.minY);
    box[2] = Math.min(box[2], b.minZ);
    box[3] = Math.max(box[3], b.maxX);
    box[4] = Math.max(box[4], b.maxY);
    box[5] = Math.max(box[5], b.maxZ);
  }
  return { volume: Math.round(volume * 1000) / 1000, box: box.map(v => Math.round(v * 1e5) / 1e5 + 0) };
}

/** Every solid the scene holds, measured together — a repeat's or a copy's instances included. */
function measureScene(scene: Scene): Built {
  const solids = scene.getAllSceneObjects().flatMap(o => o.getShapes().filter(s => s.isSolid()));
  let volume = 0;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const solid of solids) {
    volume += ShapeProps.getProperties(solid.getShape()).volumeMm3;
    const b = ShapeOps.getExactBoundingBox(solid);
    box[0] = Math.min(box[0], b.minX);
    box[1] = Math.min(box[1], b.minY);
    box[2] = Math.min(box[2], b.minZ);
    box[3] = Math.max(box[3], b.maxX);
    box[4] = Math.max(box[4], b.maxY);
    box[5] = Math.max(box[5], b.maxZ);
  }
  return { volume: Math.round(volume * 1000) / 1000, box: box.map(v => Math.round(v * 1e5) / 1e5 + 0) };
}

/**
 * The line `bolt` stands for, and the one its copy `bolt.instance(1)`
 * does, written as axes: `bolt` sits on the plate's top at (30, 0, 10), Z
 * up; its copy 20 along Y.
 */
const BOLT_LINE: AxisTransformOptions = { offsetX: 30, offsetZ: 10 };
const COPY_LINE: AxisTransformOptions = { offsetX: 30, offsetY: 20, offsetZ: 10 };

type Axes = { bolt: Connector; copy: Connector };

/**
 * A fresh scene: a 100 × 100 × 10 plate centred on the origin, the connector
 * `bolt` on its top face 30 along X, copied once 20 along Y — then whatever
 * `body` writes with an axis: the connector (`'bolt'`), its copy
 * (`'copy'`), or the same lines as `axis()` statements (`'line'`,
 * `'copy-line'`). Answers the object `body` returns — at line 6 — after the
 * render.
 */
function build(
  which: "bolt" | "copy" | "line" | "copy-line",
  body: (axisArg: unknown, plate: SceneObject) => unknown,
): { scene: Scene; made: SceneObject; axes: Axes } {
  getSceneManager().startScene();
  const out = {} as { made: SceneObject; axes: Axes };
  part("flange", () => {
    sketch("xy", () => {
      testRect(100, 100, { at: [-50, -50] });
    });
    const plate = extrude(10).new() as unknown as SceneObject;
    setLocation(plate, 2);
    const bolt = (connector("bolt", select(face().planar().onPlane("xy", 10))) as unknown as Connector).offset(30, 0, 0);
    setLocation(bolt, 3);
    const copies = copy("linear", "y", { count: 2, offset: 20 }, bolt as never);
    setLocation(copies, 4);
    out.axes = { bolt, copy: bolt.instance(1) };
    const axisArg = which === "bolt" ? bolt
      : which === "copy" ? bolt.instance(1)
        : axis("z", which === "line" ? BOLT_LINE : COPY_LINE);
    out.made = body(axisArg, plate) as SceneObject;
    if (out.made) {
      setLocation(out.made, 6);
    }
  });
  const scene = render();
  expect(errors(scene)).toEqual([]);
  return { scene, made: out.made, axes: out.axes };
}

/** A 10 × 10 profile on the front plane, 10 to 20 out from the bolt's line, for a revolve. */
function ringProfile(): SceneObject {
  return sketch("xz", () => {
    testRect(10, 10, { at: [40, 20] });
  }) as unknown as SceneObject;
}

/** A 4 × 4 × 4 block 15 to 19 along X, beside the bolt — a target to turn or repeat. */
function block(): SceneObject {
  sketch("xy", () => {
    testRect(4, 4, { at: [45, -2] });
  });
  return extrude(4).new() as unknown as SceneObject;
}

describe("a connector stands for an axis — its Z axis through its origin", () => {
  setupOC();

  describe("every built-in that takes an axis builds around it as around axis()", () => {
    it("revolve", () => {
      const around = (which: Parameters<typeof build>[0]) =>
        measure(build(which, a => revolve(a as never, ringProfile() as never).new()).made);
      const bolt = around("bolt");
      expect(bolt).toEqual(around("line"));
      // The ring is centred on the bolt's line: radii 10 to 20, 10 tall.
      expect(bolt.volume).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 10, 0);
      expect((bolt.box[0] + bolt.box[3]) / 2).toBeCloseTo(30, 6);
      expect((bolt.box[1] + bolt.box[4]) / 2).toBeCloseTo(0, 6);

      const copy = around("copy");
      expect(copy).toEqual(around("copy-line"));
      expect((copy.box[1] + copy.box[4]) / 2).toBeCloseTo(20, 6);
    });

    it("rotate", () => {
      const around = (which: Parameters<typeof build>[0]) =>
        measure(build(which, a => rotate(a as never, 90, block() as never)).made);
      const bolt = around("bolt");
      expect(bolt).toEqual(around("line"));
      // The block at x 45..49 turns a quarter about (30, 0): y 15..19.
      expect(bolt.box.slice(0, 2)).toEqual([28, 15]);
      expect(around("copy")).toEqual(around("copy-line"));
    });

    it("helix", () => {
      const around = (which: Parameters<typeof build>[0]) =>
        measure(build(which, a => helix(a as never).radius(5).pitch(2).height(10)).made);
      const bolt = around("bolt");
      expect(bolt).toEqual(around("line"));
      // From the connector's origin up along its Z.
      expect(bolt.box[2]).toBeCloseTo(10, 4);
      expect(bolt.box[5]).toBeCloseTo(20, 4);
      expect(around("copy")).toEqual(around("copy-line"));
    });

    it("repeat — circular, linear and rotate, with targets written or left to the last feature", () => {
      const makes = [
        (a: unknown, b?: SceneObject) => repeat("circular", a as never, { count: 4, angle: 360 }, ...(b ? [b as never] : [])),
        (a: unknown, b?: SceneObject) => repeat("linear", a as never, { count: 3, offset: 6 }, ...(b ? [b as never] : [])),
        (a: unknown, b?: SceneObject) => repeat("rotate", a as never, 90, ...(b ? [b as never] : [])),
      ];
      for (const make of makes) {
        const written = (which: Parameters<typeof build>[0]) => measureScene(build(which, a => make(a, block())).scene);
        // Left out, the targets are the last feature — the block, never the
        // axis the connector argument makes on the way.
        const implicit = (which: Parameters<typeof build>[0]) => measureScene(build(which, a => {
          block();
          return make(a);
        }).scene);
        const bolt = written("bolt");
        expect(bolt).toEqual(written("line"));
        expect(implicit("bolt")).toEqual(bolt);
        expect(written("copy")).toEqual(written("copy-line"));
        expect(implicit("copy")).toEqual(written("copy-line"));
      }
    });

    it("copy", () => {
      const around = (which: Parameters<typeof build>[0]) =>
        measureScene(build(which, (a) => copy("circular", a as never, { count: 3, angle: 360 }, block() as never)).scene);
      expect(around("bolt")).toEqual(around("line"));
      expect(around("copy")).toEqual(around("copy-line"));
    });

    it("axis() — the connector's Z axis, offsets and rotations included", () => {
      const { made } = build("bolt", a => axis(a as never, { offsetX: 5 }));
      const line = (made as unknown as AxisObjectBase).getAxis();
      expect([line.origin.x, line.origin.y, line.origin.z]).toEqual([35, 0, 10]);
      expect([line.direction.x, line.direction.y, line.direction.z]).toEqual([0, 0, 1]);
      // A statement of its own: a row, and its dashed line.
      expect(made.isInternal()).toBe(false);
      expect(made.getShapes({ excludeMeta: false }).length).toBe(1);
    });

    it("a custom feature's axis value, read through axisOf()", () => {
      const along = (which: Parameters<typeof build>[0]) =>
        measure(build(which, a => (pin(a as never, { length: 12 }) as unknown as SceneObject).new()).made);
      const bolt = along("bolt");
      expect(bolt).toEqual(along("line"));
      expect(bolt.box).toEqual([29, -1, 10, 31, 1, 22]);
      expect(along("copy")).toEqual(along("copy-line"));
    });
  });
  describe("the axis a connector argument makes", () => {
    it("serves its statement alone — internal, drawn nowhere — and leaves the connector on screen", () => {
      const { scene, made, axes } = build("bolt", a => revolve(a as never, ringProfile() as never).new());
      const around = (made as unknown as { axis: AxisObjectBase }).axis;
      expect(around).toBeInstanceOf(AxisFromConnector);
      expect(around.isInternal()).toBe(true);
      expect(around.getShapes({ excludeMeta: false })).toEqual([]);
      expect((around as AxisFromConnector).connector).toBe(axes.bolt);
      // The revolve consumed the axis for display; the connector keeps its gizmo vertex.
      expect(axes.bolt.getShapes({ excludeMeta: false }, undefined, new Set(scene.getAllSceneObjects()))).toHaveLength(1);
    });

    it("hits the cache on an unchanged render, and misses when the connector moves", () => {
      const manager = getSceneManager();
      const author = (x: number) => {
        const out = {} as { revolve: SceneObject };
        part("flange", () => {
          sketch("xy", () => {
            testRect(100, 100, { at: [-50, -50] });
          });
          extrude(10).new();
          const bolt = connector("bolt", select(face().planar().onPlane("xy", 10))).offset(x, 0, 0);
          out.revolve = revolve(bolt as never, ringProfile() as never).new() as unknown as SceneObject;
        });
        return out;
      };

      manager.startScene();
      author(30);
      render();
      const first = manager.currentScene;

      const again = manager.startScene();
      const second = author(30);
      again.materializeLeftoverDefinitions();
      SceneCompare.compare(first, again);
      expect(again.isCached(second.revolve)).toBe(true);
      expect(errors(render())).toEqual([]);

      const moved = manager.startScene();
      const third = author(31);
      moved.materializeLeftoverDefinitions();
      SceneCompare.compare(again, moved);
      expect(moved.isCached(third.revolve)).toBe(false);
      const scene = render();
      expect(errors(scene)).toEqual([]);
      const box = measure(third.revolve).box;
      expect((box[0] + box[3]) / 2).toBeCloseTo(31, 6);
    });

    it("fails the statement that reads it, naming the connector, when the connector did not build", () => {
      let made: SceneObject | null = null;
      part("flange", () => {
        sketch("xy", () => {
          testRect(100, 100, { at: [-50, -50] });
        });
        extrude(10).new();
        const lost = connector("lost", select(face().planar().onPlane("xy", 99)));
        made = rotate(lost as never, 90, block() as never) as unknown as SceneObject;
      });
      render();
      expect(made!.getError()).toBe("lost did not build, so it gives no axis");
    });
  });

  describe("an edit dialog's sources", () => {
    /** The sources of the statement `made` (line 6). */
    function sourcesOf(scene: Scene, made: SceneObject) {
      const index = scene.getAllSceneObjects().indexOf(made);
      expect(index).toBeGreaterThanOrEqual(0);
      const boundary: SelectionBoundary = { index, type: made.getType(), line: 6, column: 0 };
      return resolveFeatureSources(scene, boundary);
    }

    const BOLT = { kind: "connector", filePath: FILE, line: 3, column: 0 };
    const COPY = { kind: "connector", filePath: FILE, line: 3, column: 0, slot: 1 };

    it("name a connector axis by the connector's site, a copy by its seed's and its slot", () => {
      let built = build("bolt", a => revolve(a as never, ringProfile() as never).new());
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "revolve", axis: BOLT });
      built = build("copy", a => revolve(a as never, ringProfile() as never).new());
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "revolve", axis: COPY });

      built = build("copy", a => rotate(a as never, 90, block() as never));
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "rotate", axis: COPY });
      built = build("bolt", a => helix(a as never).radius(5).pitch(2).height(10));
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "helix", source: BOLT });
      built = build("bolt", a => repeat("circular", a as never, { count: 3, angle: 360 }, block() as never));
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "repeat", axes: [BOLT] });
      built = build("copy", a => repeat("linear", ["x", a as never], { count: [2, 2], offset: [5, 5] }, block() as never));
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "repeat", axes: [{ kind: "opaque" }, COPY] });
      built = build("copy", a => copy("circular", a as never, { count: 3, angle: 360 }, block() as never));
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "copy", axes: [COPY] });
      built = build("bolt", a => (pin(a as never) as unknown as SceneObject).new());
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "custom", slots: { along: BOLT } });
    });

    it("keep an axis() statement written on a connector a statement of its own; inline, it is the connector", () => {
      // `axis(bolt)` on a line of its own is an axis statement like any other.
      let built = build("bolt", a => {
        const line = axis(a as never);
        setLocation(line, 5);
        return revolve(line as never, ringProfile() as never).new();
      });
      expect(sourcesOf(built.scene, built.made)).toMatchObject({
        ok: true, feature: "revolve", axis: { kind: "sketch", filePath: FILE, line: 5, column: 0 },
      });
      // Written inline, as the dialog never writes it but a user may.
      built = build("bolt", a => revolve(axis(a as never) as never, ringProfile() as never).new());
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "revolve", axis: BOLT });
      // Offset, it no longer is the connector's line.
      built = build("bolt", a => revolve(axis(a as never, { offsetX: 2 }) as never, ringProfile() as never).new());
      expect(sourcesOf(built.scene, built.made)).toMatchObject({ ok: true, feature: "revolve", axis: { kind: "opaque" } });
    });
  });

  describe("ghosts", () => {
    /** The x/y centre of every mesh a ghost answered with. */
    function centreOf(result: FeatureGhostResult): [number, number] {
      expect(result.ok).toBe(true);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const solid of (result as Extract<FeatureGhostResult, { ok: true }>).solids) {
        for (const mesh of solid.meshes) {
          const vertices = (mesh as { vertices: number[] }).vertices;
          for (let i = 0; i < vertices.length; i += 3) {
            xs.push(vertices[i]);
            ys.push(vertices[i + 1]);
          }
        }
      }
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    }

    it("turn a built-in's ghost around a connector and its copy", () => {
      // The profile is the statement at line 6.
      const { scene } = build("line", () => ringProfile());
      for (const [ref, y] of [[{ kind: "connector", filePath: FILE, line: 3 }, 0], [{ kind: "connector", filePath: FILE, line: 3, slot: 1 }, 20]] as const) {
        const result = buildFeatureGhost(scene, {
          feature: "revolve", op: "new", angle: 360, symmetric: false, thin: null,
          profile: { filePath: FILE, line: 6 }, axis: ref,
        } as never, DEFAULT_MESH_CONFIG);
        const [cx, cy] = centreOf(result);
        expect(cx).toBeCloseTo(30, 4);
        expect(cy).toBeCloseTo(y, 4);
      }
    });

    it("stand a custom feature's axis value in at a connector and its copy, through axisOf()", () => {
      const { scene } = build("line", () => null);
      for (const [ref, y] of [[{ kind: "connector", filePath: FILE, line: 3 }, 0], [{ kind: "connector", filePath: FILE, line: 3, slot: 1 }, 20]] as const) {
        const result = buildFeatureGhost(scene, {
          feature: "custom", builder: pin, values: {}, refs: { along: [ref] }, operation: "new",
        }, DEFAULT_MESH_CONFIG);
        const [cx, cy] = centreOf(result);
        expect(cx).toBeCloseTo(30, 4);
        expect(cy).toBeCloseTo(y, 4);
      }
      // A slot the copy never made: nothing to stand in.
      const missing = buildFeatureGhost(scene, {
        feature: "custom", builder: pin, values: {}, refs: { along: [{ kind: "connector", filePath: FILE, line: 3, slot: 4 }] }, operation: "new",
      }, DEFAULT_MESH_CONFIG);
      expect(missing.ok).toBe(false);
    });
  });
});
