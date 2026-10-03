import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import hole from "../../core/hole.js";
import fillet from "../../core/fillet.js";
import part from "../../core/part.js";
import plane from "../../core/plane.js";
import select from "../../core/select.js";
import connector from "../../core/connector.js";
import repeat from "../../core/repeat.js";
import { circle } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { getCurrentScene, getSceneManager } from "../../scene-manager.js";
import { SceneObject } from "../../common/scene-object.js";
import { Solid } from "../../common/solid.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { RepeatLinear } from "../../features/repeat-linear.js";
import { Hole } from "../../features/hole/hole.js";
import { FaceProps, FaceProperties } from "../../oc/face-props.js";
import { ShapeProps } from "../../oc/props.js";
import { Point } from "../../math/point.js";
import type { SolvedCircle } from "../../features/2d/solved/circle.js";
import { testRect } from "../helpers/profiles.js";

const PLATE = { w: 200, d: 100, t: 10 };
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.t;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getType()}: ${o.getError()}`] : []);
}

/** Distinct non-container solids of the scene. */
function solidsOf(scene: Scene): Solid[] {
  const solids = new Map<string, Solid>();
  for (const obj of scene.getAllSceneObjects()) {
    if (obj.isContainer()) {
      continue;
    }
    for (const shape of obj.getShapes()) {
      if (shape instanceof Solid) {
        solids.set(shape.id, shape);
      }
    }
  }
  return [...solids.values()];
}

/**
 * Where the scene's faces of one surface type sit: the centre of each face's
 * bounding box as `x,y,z`, rounded to a tenth and sorted — a hole's wall, a
 * boss's side, a fillet's torus.
 */
function facesAt(scene: Scene, surfaceType: FaceProperties["surfaceType"] = "cylinder"): string[] {
  const centers = new Set<string>();
  // -0 and 0 must read alike.
  const round = (v: number) => (Math.round(v * 10) / 10 + 0).toFixed(1);
  for (const solid of solidsOf(scene)) {
    for (const face of solid.getFaces()) {
      if (FaceProps.getProperties(face.getShape()).surfaceType !== surfaceType) {
        continue;
      }
      const b = face.getBoundingBox();
      centers.add(`${round(b.centerX)},${round(b.centerY)},${round(b.centerZ)}`);
    }
  }
  return [...centers].sort();
}

function totalVolume(scene: Scene): number {
  return solidsOf(scene).reduce((sum, solid) => sum + ShapeProps.getProperties(solid.getShape()).volumeMm3, 0);
}

function cylinderVolume(diameter: number, length: number): number {
  return Math.PI * (diameter / 2) ** 2 * length;
}

/** The plate, with nothing on it yet. */
function plate(): ExtrudeBase {
  sketch("xy", () => {
    testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
  });
  return extrude(PLATE.t) as unknown as ExtrudeBase;
}

/** A Ø4 hole through the plate at (20, 30), placed at a sketch point. */
function drilledPlate(): Hole {
  const base = plate();
  const seat = sketch(base.endFaces(), () => {
    const c = circle([20, 30], 3);
    return { c };
  });
  return hole(4, (seat.geometries.c as unknown as SolvedCircle).center()) as unknown as Hole;
}

/** A Ø12 through cut in the plate at (20, 30), from a sketch on its top. */
function cutPlate(at: [number, number] = [20, 30]): SceneObject {
  plate();
  sketch(plane("xy", PLATE.t), () => {
    circle(at, 12);
  });
  return cut() as unknown as SceneObject;
}

const ROW = ["20.0,30.0,5.0", "45.0,30.0,5.0", "70.0,30.0,5.0"];
const MIRRORED_ROW = ["20.0,-30.0,5.0", "45.0,-30.0,5.0", "70.0,-30.0,5.0"];

describe("repeat of a repeat", () => {
  setupOC();

  it("mirrors a whole row of holes", () => {
    const h = drilledPlate();
    const row = repeat("linear", "x", { count: 3, offset: 25 }, h);
    repeat("mirror", "xz", row);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toEqual([...MIRRORED_ROW, ...ROW].sort());
    expect(totalVolume(scene)).toBeCloseTo(PLATE_VOLUME - 6 * cylinderVolume(4, PLATE.t), 2);
  });

  it("takes the repeat before it when no target is given", () => {
    cutPlate();
    repeat("linear", "x", { count: 3, offset: 25 });
    repeat("mirror", "xz");

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toEqual([...MIRRORED_ROW, ...ROW].sort());
  });

  it("takes the repeat before it inside a part", () => {
    part("plate", () => {
      cutPlate();
      repeat("linear", "x", { count: 3, offset: 25 });
      repeat("mirror", "xz");
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toEqual([...MIRRORED_ROW, ...ROW].sort());
  });

  it("repeats each feature once when the original is named beside its repeat", () => {
    const c = cutPlate();
    const row = repeat("linear", "x", { count: 3, offset: 25 }, c);
    const m = repeat("mirror", "xz", c, row) as unknown as RepeatBase;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toEqual([...MIRRORED_ROW, ...ROW].sort());
    expect(m.getInstanceRoots(1)).toHaveLength(3);
  });

  it("keeps the turn of a circular repeat under a mirror", () => {
    // A tube with three radial holes 30° apart at z 30, mirrored about z 50.
    sketch("xy", () => {
      circle([0, 0], 60);
      circle([0, 0], 50);
    });
    extrude(100);
    sketch("yz", () => {
      circle([0, 30], 4);
    });
    const c = cut(40);
    const ring = repeat("circular", "z", { count: 3, offset: 30 }, c);
    repeat("mirror", plane("xy", 50), ring);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const radial = facesAt(scene).filter(center => !center.startsWith("0.0,0.0"));
    expect(radial).toEqual([
      "-13.7,-23.8,30.0", "-13.7,-23.8,70.0",
      "-23.8,-13.7,30.0", "-23.8,-13.7,70.0",
      "-27.5,0.0,30.0", "-27.5,0.0,70.0",
    ]);
  });

  it("repeats to any depth", () => {
    const c = cutPlate();
    const row = repeat("linear", "x", { count: 3, offset: 25 }, c);
    const half = repeat("mirror", "xz", row);
    const all = repeat("mirror", "yz", half) as unknown as RepeatBase;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toHaveLength(12);
    expect(facesAt(scene)).toContain("-70.0,-30.0,5.0");
    expect(all.getPatternRoots()).toHaveLength(12);
  });

  it("repeats the slots the inner repeat kept, a centered one's original included", () => {
    plate();
    sketch(plane("xy", PLATE.t), () => {
      circle([40, 0], 6);
    });
    const c = cut();
    // y = -15 skipped, 0 (the original) and 15.
    const column = repeat("linear", "y", { count: 3, offset: 15, centered: true, skip: [[0]] }, c);
    repeat("rotate", "z", 180, column);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toEqual(["-40.0,-15.0,5.0", "-40.0,0.0,5.0", "40.0,0.0,5.0", "40.0,15.0,5.0"]);
  });

  it("repeats several features per instance", () => {
    plate();
    sketch(plane("xy", PLATE.t), () => {
      circle([20, 30], 12);
    });
    const boss = extrude(8) as unknown as ExtrudeBase;
    const round = fillet(2, boss.endEdges());
    const row = repeat("linear", "x", { count: 3, offset: 25 }, boss, round);
    repeat("mirror", "xz", row);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene, "torus")).toHaveLength(6);
    expect(facesAt(scene, "torus")).toContain("45.0,-30.0,17.0");
  });

  it("repeats one instance of a repeat", () => {
    const h = drilledPlate();
    const row = repeat("linear", "x", { count: 3, offset: 25 }, h);
    const m = repeat("mirror", "xz", row.instance(2)) as unknown as RepeatBase;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene)).toEqual(["70.0,-30.0,5.0", ...ROW].sort());
    expect(m.getInstanceRoots(1)).toHaveLength(1);
    expect(m.getInstanceRoots(1)[0]).toBeInstanceOf(Hole);
  });

  it("repeats a feature built on an instance, with the instance it was built on", () => {
    plate();
    sketch(plane("xy", PLATE.t), () => {
      circle([20, 30], 12);
    });
    const boss = extrude(8) as unknown as ExtrudeBase;
    const row = repeat("linear", "x", { count: 3, offset: 25 }, boss);
    const round = fillet(2, row.instance(1).endEdges());
    repeat("mirror", "xz", round);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene, "torus")).toEqual(["45.0,-30.0,17.0", "45.0,30.0,17.0"]);
    // Three bosses on the original side, the rounded one alone mirrored.
    expect(facesAt(scene)).toHaveLength(4);
  });

  it("repeats a repeat and a feature built on one of its instances together", () => {
    plate();
    sketch(plane("xy", PLATE.t), () => {
      circle([20, 30], 12);
    });
    const boss = extrude(8) as unknown as ExtrudeBase;
    const row = repeat("linear", "x", { count: 3, offset: 25 }, boss);
    const round = fillet(2, row.instance(1).endEdges());
    repeat("mirror", "xz", row, round);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(facesAt(scene, "torus")).toEqual(["45.0,-30.0,17.0", "45.0,30.0,17.0"]);
    expect(facesAt(scene)).toHaveLength(6);
  });

  it("repeats a selection scoped to an instance with the instance", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [0, 30] });
    });
    const box = extrude(10).new() as unknown as ExtrudeBase;
    const row = repeat("linear", "x", { count: 3, offset: 40 }, box);
    const round = fillet(2, select(edge().from(row.instance(1)).line()));
    repeat("mirror", "xz", round);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    // Every edge of the middle box is a line: all 12 fillet, on the box and
    // on its mirror image — the other two boxes stay plain.
    const cylinders = (solid: Solid) => solid.getFaces()
      .filter(f => FaceProps.getProperties(f.getShape()).surfaceType === "cylinder").length;
    const byPlace = solidsOf(scene)
      .map(solid => {
        const b = ShapeProps.getProperties(solid.getShape()).centroid;
        return `${Math.round(b.x)},${Math.round(b.y)}: ${cylinders(solid)}`;
      })
      .sort();
    expect(byPlace).toEqual(["10,40: 0", "50,-40: 12", "50,40: 12", "90,40: 0"]);
  });

  it("maps an indexed accessor on an instance through both moves", () => {
    sketch("xy", () => {
      testRect(20, 10, { at: [0, 30] });
    });
    const box = extrude(10).new() as unknown as ExtrudeBase;
    const row = repeat("linear", "x", { count: 2, offset: 40 }, box);
    const original = fillet(2, row.instance(1).sideEdges(0)) as unknown as SceneObject;
    const m = repeat("mirror", "xz", original) as unknown as RepeatBase;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const rounded = (feature: SceneObject) => {
      const b = (feature.getShapes({}, "solid")[0] as Solid).getFaces()
        .find(f => FaceProps.getProperties(f.getShape()).surfaceType === "cylinder")!.getBoundingBox();
      return [b.centerX, b.centerY];
    };
    const [x, y] = rounded(original);
    const [mx, my] = rounded(m.getInstanceRoots(1)[0]);
    // The mirrored fillet rounds the mirror image of the very edge.
    expect(mx).toBeCloseTo(x, 3);
    expect(my).toBeCloseTo(-y, 3);
  });
});

describe("repeat of a repeat — structure", () => {
  setupOC();

  it("keeps its targets as written and its own slot numbering", () => {
    const c = cutPlate();
    const row = repeat("linear", "x", { count: 3, offset: 25 }, c) as unknown as RepeatLinear;
    const m = repeat("mirror", "xz", row) as unknown as RepeatBase & { targetObjects: SceneObject[] };

    expect(m.targetObjects).toEqual([row]);
    expect(m.getInstanceSlots()).toHaveLength(2);
    expect(m.getOriginalSlot()).toBe(0);
    // Slot 0 is the inner pattern as it stands, slot 1 its mirror image.
    expect(m.getInstanceRoots(0)).toEqual(row.getPatternRoots());
    expect(m.getInstanceRoots(0)[0]).toBe(c);
    expect(m.getInstanceRoots(1)).toHaveLength(3);
    for (const root of m.getInstanceRoots(1)) {
      expect(root.getParent()).toBe(m);
    }
  });

  it("makes every clone a clone of the original, moved by both repeats", () => {
    const c = cutPlate();
    const row = repeat("linear", "x", { count: 3, offset: 25 }, c) as unknown as RepeatBase;
    const m = repeat("mirror", "xz", row) as unknown as RepeatBase;
    render();

    const [first, second, third] = m.getInstanceRoots(1);
    for (const root of [first, second, third]) {
      expect(root.getCloneSource()).toBe(c);
    }
    const moved = (root: SceneObject) => {
      const p = root.getTransform()!.transformPoint(new Point(20, 30, 0));
      return [p.x, p.y, p.z];
    };
    expect(moved(first)).toEqual([20, -30, 0]);
    expect(moved(second)).toEqual([45, -30, 0]);
    expect(moved(third)).toEqual([70, -30, 0]);
    // One move per inner instance, shared by everything cloned with it.
    const group = m.getChildren().filter(child => child.getTransformRef() === second.getTransformRef());
    expect(group.length).toBeGreaterThan(1);
    expect(group).not.toContain(first);
  });

  it("selects the whole repeated pattern through instance()", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [0, 30] });
    });
    const box = extrude(10).new() as unknown as ExtrudeBase;
    const row = repeat("linear", "x", { count: 3, offset: 40 }, box);
    const m = repeat("mirror", "xz", row);
    render();

    const half = m.instance(1) as unknown as SceneObject;
    expect(half.getShapes({}, "solid")).toHaveLength(3);
    expect(() => m.instance(1).endEdges()).toThrow(/3 features per instance/);
  });

  it("refuses to repeat a repeat that was refused", () => {
    const out = {} as { outer: SceneObject };
    part("flange", () => {
      const base = plate();
      const bolt = connector("bolt", base.endFaces().center()) as unknown as SceneObject;
      const refused = repeat("linear", "x", { count: 2, offset: 10 }, bolt as never);
      out.outer = repeat("mirror", "xz", refused) as unknown as SceneObject;
    });

    const scene = render();
    expect(out.outer.getChildren()).toEqual([]);
    expect(out.outer.getError()).toMatch(/the repeat this one repeats is refused/);
    expect(scene.getAllSceneObjects().filter(o => o.getCloneSource() !== null)).toEqual([]);
  });

  it("rebuilds from the inner repeat on when its count changes", () => {
    const model = (count: number) => {
      cutPlate();
      repeat("linear", "x", { count, offset: 20 });
      repeat("mirror", "xz");
    };

    model(3);
    const first = render();

    getSceneManager().startScene();
    model(3);
    const same = SceneCompare.compare(first, getCurrentScene());
    expect(same.getAllSceneObjects().every(o => same.isCached(o))).toBe(true);
    const second = render();
    expect(facesAt(second)).toHaveLength(6);

    getSceneManager().startScene();
    model(4);
    const changed = SceneCompare.compare(second, getCurrentScene());
    const objects = changed.getAllSceneObjects();
    const inner = objects.findIndex(o => o instanceof RepeatLinear);
    expect(objects.slice(0, inner).every(o => changed.isCached(o))).toBe(true);
    expect(objects.slice(inner).some(o => changed.isCached(o))).toBe(false);

    const third = render();
    expect(errorsOf(third)).toEqual([]);
    expect(facesAt(third)).toHaveLength(8);
    expect(facesAt(third)).toContain("80.0,-30.0,5.0");
  });
});
