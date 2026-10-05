import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import copy from "../../core/copy.js";
import { testRect } from "../helpers/profiles.js";
import * as occt from "../../sdk/occt.js";
import { getOC } from "../../oc/init.js";
import { OccScope } from "../../oc/occ-scope.js";
import { KernelTraps, type KernelTrapReport } from "../../oc/kernel-traps.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeFactory, type Shape } from "../../sdk/kernel.js";
import { Feature, defineFeature } from "../../sdk/index.js";
import { buildFeatureGhost } from "../../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { faceRefsWhere } from "../selection/pick-helpers.js";
import type { ExtrudeBase } from "../../features/extrude-base.js";
import { defineTwist, twist } from "../fixtures/custom-features/twist.js";

// Raw OpenCascade for custom features: the `fluidcad/sdk/occt` entry, the
// scope that frees what raw code makes (`Feature.occ()`), and the crash
// guard that turns a trap of the kernel into a row error and a report.

const BASE = { side: 20, height: 10 };
const BASE_VOLUME = BASE.side * BASE.side * BASE.height;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function solidVolumes(scene: Scene): number[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3)
    .sort((a, b) => a - b);
}

/** A 20 × 20 × 10 square prism centred on the origin, its top face at z = 10. */
function prism(): ExtrudeBase {
  sketch("xy", () => {
    testRect(BASE.side, BASE.side, { at: [-BASE.side / 2, -BASE.side / 2] });
  });
  return extrude(BASE.height) as unknown as ExtrudeBase;
}

/** A twisted column of the prism's square, `height` tall: its volume is the square's area times the height, less the bore. */
function twistVolume(height: number, bore = 0): number {
  return BASE.side * BASE.side * height - Math.PI * (bore / 2) ** 2 * height;
}

describe("the fluidcad/sdk/occt entry", () => {
  it("exports the engine's OpenCascade instance and the scope its code runs in", () => {
    expect(Object.keys(occt).sort()).toEqual(["OccScope", "getOC"]);
    expect(occt.getOC()).toBe(getOC());
  });
});

describe("a custom feature built with raw OpenCascade: the twist", () => {
  setupOC();

  it("lofts the face's outline up through turned copies of it, fused onto the prism", () => {
    const base = prism();
    twist(base.endFaces(), { height: 30, angle: 60 });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toBeCloseTo(BASE_VOLUME + twistVolume(30), 2);
    // The top turned 60° about the face's centre: the square's corners now
    // reach out to its half-diagonal along a line at 45° + 60°.
    const box = ShapeOps.getExactBoundingBox(scene.getSceneObjects().flatMap(o => o.getShapes()).find(s => s.isSolid())!);
    expect(box.maxZ).toBeCloseTo(40, 6);
  });

  it("follows its twist corner for corner, however large each step — a square turned 45° a section", () => {
    const base = prism();
    twist(base.endFaces(), { height: 30, angle: 360, sections: 8 });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    // Paired corner to corner, every section is the square: the column's
    // volume is the square's area times its height, and it stays within the
    // square's circle. Re-paired, the loft would fold and swell.
    expect(Math.abs(solidVolumes(scene)[0] - (BASE_VOLUME + twistVolume(30)))).toBeLessThan(0.001 * twistVolume(30));
    const box = ShapeOps.getExactBoundingBox(scene.getSceneObjects().flatMap(o => o.getShapes()).find(s => s.isSolid())!);
    expect(box.maxX).toBeLessThan(BASE.side / Math.SQRT2 + 0.5);
  });

  it("bores it, and names its faces", () => {
    const base = prism();
    const tw = twist(base.endFaces(), { height: 30, angle: 90, bore: 4 }).new() as unknown as SceneObject & {
      endFaces(): unknown; internalFaces(): unknown; sideFaces(): unknown;
    };
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)).toEqual([expect.closeTo(BASE_VOLUME, 6), expect.closeTo(twistVolume(30, 4), 2)]);
    const faces = (key: string) => (tw.getState(key) as Shape[]).length;
    expect(faces('start-faces')).toBe(1);
    expect(faces('end-faces')).toBe(1);
    expect(faces('internal-faces')).toBeGreaterThanOrEqual(1);
    expect(faces('side-faces')).toBe(4);
  });

  it("is served from the cache when the class is defined again, as a re-evaluated module defines it", () => {
    const manager = getSceneManager();
    const first = defineTwist();
    const second = defineTwist();
    const base1 = prism();
    first.twist(base1.endFaces(), { height: 25 });
    render();
    const previous = manager.currentScene;

    const next = manager.startScene();
    const base2 = prism();
    const again = second.twist(base2.endFaces(), { height: 25 }) as unknown as SceneObject;
    SceneCompare.compare(previous, next);
    expect(next.isCached(again)).toBe(true);
    expect(errorsOf(render())).toEqual([]);
  });

  it("repeats and copies", () => {
    const base = prism();
    const tw = twist(base.endFaces(), { height: 20 }) as unknown as SceneObject;
    repeat("linear", "x", { count: 2, offset: 40 }, tw);
    const repeated = render();
    expect(errorsOf(repeated)).toEqual([]);
    // The prism with its column, and the column's copy standing alone.
    expect(solidVolumes(repeated)).toEqual([
      expect.closeTo(twistVolume(20), 2),
      expect.closeTo(BASE_VOLUME + twistVolume(20), 2),
    ]);

    getSceneManager().startScene();
    const base2 = prism();
    const column = (twist(base2.endFaces(), { height: 20, angle: 45 }) as unknown as SceneObject).new();
    copy("linear", "y", { count: 3, offset: 40 }, column);
    const copied = render();
    expect(errorsOf(copied)).toEqual([]);
    expect(solidVolumes(copied).filter(v => Math.abs(v - twistVolume(20)) < 1e-2)).toHaveLength(3);
  });
});

describe("the scope raw code runs in", () => {
  setupOC();

  it("frees what the scope made, and spares what it returns or keeps", () => {
    let made: { point: any; direction: any; axis: any; kept: any; solid: any } | null = null;
    const returned = OccScope.run(({ oc, keep }) => {
      const point = new oc.gp_Pnt(0, 0, 1);
      const direction = new oc.gp_Dir(0, 0, 1);
      const axis = new oc.gp_Ax1(point, direction);
      const kept = keep(new oc.gp_Pnt(1, 2, 3));
      const maker = new oc.BRepPrimAPI_MakeCylinder(2, 5);
      const solid = new oc.TopoDS_Compound();
      new oc.BRep_Builder().MakeCompound(solid);
      made = { point, direction, axis, kept, solid };
      void maker;
      return { solid, wrapped: ShapeFactory.fromShape(maker.Shape()) };
    });
    expect(made!.point.isDeleted()).toBe(true);
    expect(made!.direction.isDeleted()).toBe(true);
    expect(made!.axis.isDeleted()).toBe(true);
    expect(made!.kept.isDeleted()).toBe(false);
    expect(made!.kept.Y()).toBe(2);
    // A raw object the scope returns stays, and so does every raw handle a
    // returned wrapper holds.
    expect(made!.solid.isDeleted()).toBe(false);
    expect((returned.wrapped.getShape() as unknown as { isDeleted(): boolean }).isDeleted()).toBe(false);
    expect(ShapeProps.getProperties(returned.wrapped.getShape()).volumeMm3).toBeCloseTo(Math.PI * 4 * 5, 6);
    made!.kept.delete();
    made!.solid.delete();
    returned.wrapped.dispose();
  });

  it("frees on a throw too, and the throw still reaches the caller", () => {
    const made: any[] = [];
    expect(() => OccScope.run(({ oc }) => {
      made.push(new oc.gp_Pnt(1, 1, 1), new oc.gp_Vec(0, 1, 0));
      throw new Error('twist: no profile');
    })).toThrow('twist: no profile');
    expect(made.map(object => object.isDeleted())).toEqual([true, true]);
  });

  it("clears an algorithm before deleting it, and nulls a handle: what delete() alone leaves behind", () => {
    let history: any = null;
    OccScope.run(({ oc, track }) => {
      const a = new oc.BRepPrimAPI_MakeCylinder(3, 10);
      const b = new oc.BRepPrimAPI_MakeCylinder(1.5, 10);
      const cut = new oc.BRepAlgoAPI_Cut(track(a.Shape()), track(b.Shape()), new oc.Message_ProgressRange());
      history = cut.History();
      // The scope's own reference and the algorithm's.
      expect(history.GetRefCount()).toBe(2);
      track(cut.History());
      expect(history.GetRefCount()).toBe(3);
    });
    // Cleared, the algorithm gave its reference back, and the tracked
    // handle was nulled: only this test's reference is left.
    expect(history.GetRefCount()).toBe(1);
    history.delete();
  });

  it("tracks what a method returns only when handed it, and refuses anything else", () => {
    const shapes: any[] = [];
    OccScope.run(({ oc, track }) => {
      const maker = new oc.BRepPrimAPI_MakeCylinder(1, 2);
      shapes.push(track(maker.Shape()), maker.Shape());
      expect(() => track({ not: 'bound' } as any)).toThrow('track() takes an object of the OpenCascade binding, got a plain object');
    });
    expect(shapes.map(shape => shape.isDeleted())).toEqual([true, false]);
    shapes[1].delete();
  });

  it("refuses an async scope, freeing what it made before the first await", async () => {
    let point: any = null;
    expect(() => OccScope.run((async ({ oc }: any) => {
      point = new oc.gp_Pnt(0, 0, 0);
    }) as any)).toThrow("occ(): the scope runs synchronously");
    expect(point.isDeleted()).toBe(true);
  });

  it("never frees a shape the scene holds, though the code handed it over", () => {
    let held: any = null;
    class Grip extends Feature.with({ face: { picker: 'face' } }) {
      static id = 'acme.grip';
      buildTool(): Shape[] {
        const [face] = this.facesOf(this.values.face);
        return this.occ(({ oc, track }) => {
          held = track(face.getShape());
          const post = new oc.BRepPrimAPI_MakeCylinder(new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 10), new oc.gp_Dir(0, 0, 1)), 2, 5);
          return [ShapeFactory.fromShape(track(post.Shape()))];
        });
      }
    }
    const grip = defineFeature(Grip, { label: 'Grip', group: 'create', call: ['face'] });

    const base = prism();
    grip(base.endFaces());
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(held.isDeleted()).toBe(false);
    expect(held.IsNull()).toBe(false);
    expect(solidVolumes(scene)[0]).toBeCloseTo(BASE_VOLUME + Math.PI * 4 * 5, 2);
  });
});

/** A feature whose raw code reads through a pointer to memory that isn't there, as freed-and-reused memory ends. */
function defineDangling() {
  class Dangling extends Feature.with({ face: { picker: 'face' } }) {
    static id = 'acme.dangling';
    buildTool(): Shape[] {
      // Past the end of any 32-bit wasm heap: the read traps before it can
      // touch anything.
      getOC().OCJS.getStandard_FailureData(0xFFFFFFFD);
      return [];
    }
  }
  return defineFeature(Dangling, { label: 'Dangling pointer', group: 'create', call: ['face'] });
}

describe("the crash guard", () => {
  setupOC();

  it("fails a build the kernel trapped in on its own row, reports it, and builds the rest", () => {
    const reports: KernelTrapReport[] = [];
    const stop = KernelTraps.onTrap(report => reports.push(report));
    const before = KernelTraps.trapCount;
    try {
      const dangling = defineDangling();
      const base = prism();
      const bad = dangling(base.endFaces()) as unknown as SceneObject;
      twist(base.endFaces(), { height: 15 });
      const scene = render();

      expect(bad.getError()).toBe(
        'Dangling pointer crashed the OpenCascade kernel (memory access out of bounds). The engine\'s memory may be damaged: '
        + 'what it builds from now on is suspect until the engine restarts.',
      );
      expect(bad.isKernelTrap()).toBe(true);
      const row = scene.getRenderedObject(bad) as { hasError: boolean; kernelTrap?: boolean };
      expect(row.hasError).toBe(true);
      expect(row.kernelTrap).toBe(true);
      expect(KernelTraps.trapCount).toBe(before + 1);
      expect(KernelTraps.suspect).toBe(true);
      expect(reports).toEqual([expect.objectContaining({
        message: 'memory access out of bounds', type: 'acme.dangling', name: 'Dangling pointer', during: 'build',
      })]);
      // The prism and the twist on it built all the same.
      expect(errorsOf(scene)).toEqual([expect.stringContaining('acme.dangling: Dangling pointer crashed')]);
      expect(solidVolumes(scene)[0]).toBeCloseTo(BASE_VOLUME + twistVolume(15), 2);

      // And the next render runs: the kernel kept working.
      getSceneManager().startScene();
      const again = prism();
      twist(again.endFaces(), { height: 5 });
      expect(errorsOf(render())).toEqual([]);
    } finally {
      stop();
    }
  });

  it("tells an ordinary error from a trap", () => {
    expect(KernelTraps.isTrap(new Error('twist: no profile'))).toBe(false);
    expect(KernelTraps.isTrap(42)).toBe(false);
    expect(KernelTraps.isTrap(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
    const foreign = new Error('table index is out of bounds');
    foreign.name = 'RuntimeError';
    expect(KernelTraps.isTrap(foreign)).toBe(true);
  });

  it("reports a trap in a dialog's preview, which refuses to draw", () => {
    const reports: KernelTrapReport[] = [];
    const stop = KernelTraps.onTrap(report => reports.push(report));
    try {
      const dangling = defineDangling();
      prism();
      const scene = render();
      const solid = scene.getSceneObjects().flatMap(o => o.getShapes()).find(s => s.isSolid())!;
      const [top] = faceRefsWhere(solid, mid => Math.abs(mid.z - BASE.height) < 1e-6);
      const result = buildFeatureGhost(scene, {
        feature: 'custom',
        builder: dangling,
        values: {},
        refs: { face: [{ kind: 'entities', entities: [{ shapeId: top.shapeId, index: top.sub.index, kind: 'face' }] }] },
        operation: null,
      }, DEFAULT_MESH_CONFIG);
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('Dangling pointer crashed the OpenCascade kernel (memory access out of bounds)') });
      expect(reports).toEqual([expect.objectContaining({ type: 'acme.dangling', during: 'preview' })]);
    } finally {
      stop();
    }
  });
});

describe("the heap under raw OpenCascade", () => {
  // Measured in a process of its own: the measure fills the kernel's heap
  // on purpose, and the control leaks megabytes a build — neither belongs
  // in the heap the rest of the suite shares. See occt-heap.test.ts.
  it("stays flat over 1000 builds of the twist, where the twist outside its scope grows", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const out = path.join(tmpdir(), `fluidcad-occt-heap-${process.pid}.json`);
    rmSync(out, { force: true });
    execFileSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "lib/tests/sdk/occt-heap.test.ts"], {
      cwd: root,
      env: { ...process.env, FLUIDCAD_OCCT_HEAP_OUT: out },
      stdio: "pipe",
      timeout: 240_000,
    });
    expect(existsSync(out)).toBe(true);
    const heap = JSON.parse(readFileSync(out, "utf8")) as {
      scoped: { builds: number; growthMb: number; perBuildKb: number };
      control: { builds: number; growthMb: number; perBuildKb: number };
      probeNoiseMb: number;
    };
    rmSync(out, { force: true });

    // The scope frees everything the binding lets it free; what stays is
    // the loft's own internals, which only a destructor frees — tens of
    // kilobytes a build, inside the probe's noise over a thousand builds.
    expect(heap.scoped.builds).toBe(1000);
    expect(heap.scoped.perBuildKb).toBeLessThan(250);
    // Without it, every build leaves its boolean's intersection data behind.
    expect(heap.control.perBuildKb).toBeGreaterThan(1000);
    expect(heap.control.perBuildKb).toBeGreaterThan(10 * Math.max(heap.scoped.perBuildKb, 1));
  }, 300_000);
});

