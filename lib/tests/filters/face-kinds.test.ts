import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import {
  sketch, line, arc, spline, circle, ellipse, fillet, extrude, revolve, loft, sphere, select, plane, repeat,
} from "../../core/index.js";
import { face } from "../../filters/index.js";
import { FaceFilterBuilder } from "../../filters/face/face-filter.js";
import { FacingFilter } from "../../filters/face/facing.js";
import { SelectSceneObject } from "../../features/select.js";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { SurfaceClassifier, SurfaceKind } from "../../oc/surface-classifier.js";
import { FaceQuery } from "../../oc/face-query.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Vector3d } from "../../math/vector3d.js";
import { Point } from "../../math/point.js";
import { testRect } from "../helpers/profiles.js";

function kinds(sel: SelectSceneObject): SurfaceKind[] {
  return (sel.getShapes() as Face[]).map(f => SurfaceClassifier.classify(f).kind).sort();
}

function count(sel: SelectSceneObject): number {
  return sel.getShapes().length;
}

/** A closed profile in the xz plane: a line out, a spline up, a line back and down the z axis. */
function splineProfile() {
  line([0, 0], [10, 0]);
  spline([10, 0], [14, 5], [9, 10], [13, 15]);
  line([13, 15], [0, 15]);
  line([0, 15], [0, 0]);
}

/** A loft from a Ø40 circle to a 10 × 18 ellipse 30 above it: one free-form wall between two flat ends. */
function circleToEllipse() {
  const base = sketch(plane("xy", 0), () => {
    circle([0, 0], 40);
  });
  const top = sketch(plane("xy", 30), () => {
    ellipse([0, 0], 5, 9);
  });
  return loft(base, top);
}

/**
 * A spherical cap on a disc: the profile's arc is centred 10 below the base,
 * so the cap rises from 45° to the pole and its centre normal leans 22.5°
 * off the z axis.
 */
function dome() {
  sketch("xz", () => {
    line([0, 0], [10, 0]);
    arc([10, 0], [0, Math.SQRT2 * 10 - 10], [0, -10]);
    line([0, Math.SQRT2 * 10 - 10], [0, 0]);
  });
  return revolve("z");
}

describe("face kind predicates", () => {
  setupOC();

  it("sphere() keeps a sphere's face, by diameter when given", () => {
    sphere(10);
    const any = select(face().sphere()) as SelectSceneObject;
    const sized = select(face().sphere(20)) as SelectSceneObject;
    const wrongSize = select(face().sphere(10)) as SelectSceneObject;
    const notSphere = select(face().notSphere()) as SelectSceneObject;
    const notSized = select(face().notSphere(10)) as SelectSceneObject;
    render();
    expect(kinds(any)).toEqual(["sphere"]);
    expect(count(sized)).toBe(1);
    expect(count(wrongSize)).toBe(0);
    expect(count(notSphere)).toBe(0);
    expect(count(notSized)).toBe(1);
  });

  it("sphere(d) holds a native sphere to OCCT's precision, as cylinder(d) holds a cylinder", () => {
    const ball = sphere(10) as unknown as SceneObject;
    render();
    const [surface] = ball.getShapes()[0].getSubShapes("face") as Face[];
    expect(FaceQuery.isSphereFace(surface, 20)).toBe(true);
    // Half a micron off the diameter: within the tolerance a recovered sphere gets, not a native one.
    expect(FaceQuery.isSphereFace(surface, 20.0005)).toBe(false);
    expect(FaceQuery.isSphereFace(surface, 20 + 1e-8)).toBe(true);
  });

  it("freeform() keeps a loft's free-form wall, notFreeform() its flat ends", () => {
    circleToEllipse();
    const freeform = select(face().freeform()) as SelectSceneObject;
    const others = select(face().notFreeform()) as SelectSceneObject;
    render();
    expect(kinds(freeform)).toEqual(["freeform"]);
    expect(kinds(others)).toEqual(["plane", "plane"]);
  });

  it("revolved() keeps a revolved spline wall, notRevolved() the rest", () => {
    sketch("xz", splineProfile);
    revolve("z");
    const revolved = select(face().revolved()) as SelectSceneObject;
    const others = select(face().notRevolved()) as SelectSceneObject;
    render();
    expect(kinds(revolved)).toEqual(["revolved"]);
    expect(kinds(others)).toEqual(["plane", "plane"]);
  });

  it("extruded() keeps an extruded spline wall, notExtruded() the rest", () => {
    sketch("xy", splineProfile);
    extrude(10);
    const extruded = select(face().extruded()) as SelectSceneObject;
    const others = select(face().notExtruded()) as SelectSceneObject;
    render();
    expect(kinds(extruded)).toEqual(["extruded"]);
    expect(count(others)).toBe(5);
    expect(kinds(others)).not.toContain("extruded");
  });

  it("planar() keeps the flat walls and ends of a loft stored as B-splines", () => {
    const rounded = (z: number) => sketch(plane("xy", z), () => {
      const b = line([-11, -8], [11, -8]);
      const r = line([11, -8], [11, 8]);
      const t = line([11, 8], [-11, 8]);
      const l = line([-11, 8], [-11, -8]);
      fillet(4, b, r, t, l);
    });
    loft(rounded(0), rounded(20));
    const flat = select(face().planar()) as SelectSceneObject;
    const top = select(face().planar().onPlane("xy", 20)) as SelectSceneObject;
    render();
    // Two native end caps and four flat walls the loft stores as B-splines.
    expect(count(flat)).toBe(6);
    expect((flat.getShapes() as Face[]).filter(f => SurfaceClassifier.classify(f).recovered)).toHaveLength(4);
    expect(count(top)).toBe(1);
  });

  it("onPlane() keeps a flat wall a loft stores as a B-spline", () => {
    const rounded = (z: number) => sketch(plane("xy", z), () => {
      const b = line([-11, -8], [11, -8]);
      const r = line([11, -8], [11, 8]);
      const t = line([11, 8], [-11, 8]);
      const l = line([-11, 8], [-11, -8]);
      fillet(4, b, r, t, l);
    });
    loft(rounded(0), rounded(20));
    const front = select(face().onPlane("xz", 8)) as SelectSceneObject;
    const back = select(face().onPlane("xz", -8)) as SelectSceneObject;
    const between = select(face().onPlane("xz", 7)) as SelectSceneObject;
    const parallel = select(face().parallelTo("xz")) as SelectSceneObject;
    const offPlane = select(face().parallelTo("xz").notOnPlane("xz", 8)) as SelectSceneObject;
    render();
    for (const wall of [front, back]) {
      expect(count(wall)).toBe(1);
      expect(SurfaceClassifier.classify(wall.getShapes()[0] as Face)).toMatchObject({ kind: "plane", recovered: true });
    }
    expect(front.getShapes()[0]).not.toBe(back.getShapes()[0]);
    expect(count(between)).toBe(0);
    expect(count(parallel)).toBe(2);
    expect(count(offPlane)).toBe(1);
  });

  describe("facing()", () => {
    it("keeps a box's top only, and widens with within", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      extrude(5);
      const up = select(face().facing("z")) as SelectSceneObject;
      const down = select(face().facing("-z")) as SelectSceneObject;
      const notUp = select(face().notFacing("z")) as SelectSceneObject;
      const upAndWalls = select(face().facing("z", 90)) as SelectSceneObject;
      const vector = select(face().facing([0, 0, 1], 10)) as SelectSceneObject;
      render();
      expect(count(up)).toBe(1);
      expect((up.getShapes()[0] as Face).center().z).toBeCloseTo(5, 6);
      expect(count(down)).toBe(1);
      expect((down.getShapes()[0] as Face).center().z).toBeCloseTo(0, 6);
      expect(count(notUp)).toBe(5);
      expect(count(upAndWalls)).toBe(5);
      expect(count(vector)).toBe(1);
    });

    it("keeps a dome's cap, and leaves it out when within is tighter than its lean", () => {
      dome();
      const up = select(face().facing("z")) as SelectSceneObject;
      const tight = select(face().facing("z", 20)) as SelectSceneObject;
      const loose = select(face().facing("z", 25)) as SelectSceneObject;
      const down = select(face().facing("-z")) as SelectSceneObject;
      render();
      expect(kinds(up)).toEqual(["sphere"]);
      expect(count(tight)).toBe(0);
      expect(kinds(loose)).toEqual(["sphere"]);
      expect(kinds(down)).toEqual(["plane"]);
    });

    it("works on a free-form face", () => {
      circleToEllipse();
      const upward = select(face().facing("z", 89)) as SelectSceneObject;
      const top = select(face().facing("z", 1)) as SelectSceneObject;
      const downward = select(face().facing("-z", 89)) as SelectSceneObject;
      render();
      // The loft narrows as it rises, so its wall leans up and out: within
      // 89° of up, though nowhere near straight up like the top end.
      expect(kinds(upward)).toEqual(["freeform", "plane"]);
      expect(kinds(top)).toEqual(["plane"]);
      expect(kinds(downward)).toEqual(["plane"]);
      const wall = (upward.getShapes() as Face[]).find(f => SurfaceClassifier.classify(f).kind === "freeform")!;
      const normal = FaceQuery.centreNormal(wall)!;
      expect(normal.z).toBeGreaterThan(0);
      expect(Math.hypot(normal.x, normal.y)).toBeGreaterThan(normal.z);
    });

    it("turns its direction with a mirrored repeat", () => {
      sketch("xy", () => {
        testRect(20, 10, { at: [10, 0] });
      });
      const body = extrude(5) as unknown as SceneObject;
      const outward = select(face().facing("x")) as SelectSceneObject;
      repeat("mirror", "yz", body, outward);
      const scene = render();
      expect(scene.getSceneObjects().map(o => o.getError()).filter(Boolean)).toEqual([]);
      expect(count(outward)).toBe(1);
      expect((outward.getShapes()[0] as Face).center().x).toBeCloseTo(30, 6);
      const clones = scene.getAllSceneObjects().filter(o => o.getCloneSource() === outward) as SelectSceneObject[];
      expect(clones).toHaveLength(1);
      expect(clones[0].getShapes()).toHaveLength(1);
      // The mirrored copy's outer face faces -x, at x = -30, not its inner face at x = -10.
      expect((clones[0].getShapes()[0] as Face).center().x).toBeCloseTo(-30, 6);
    });

    it("compares by direction and angle, and a mirror flips the direction", () => {
      const filter = face().facing("x", 30).getFilters()[0] as FacingFilter;
      const mirrored = filter.transform(Matrix4.mirrorPlane(new Vector3d(1, 0, 0), new Point(0, 0, 0)));
      expect(mirrored.compareTo(face().facing("-x", 30).getFilters()[0] as FacingFilter)).toBe(true);
      expect(mirrored.compareTo(filter)).toBe(false);
      expect(filter.compareTo(face().facing("x", 40).getFilters()[0] as FacingFilter)).toBe(false);
      expect(filter.compareTo(face().facing([1, 0, 0], 30).getFilters()[0] as FacingFilter)).toBe(true);
    });

    it("refuses a direction that names none, where the filter is written", () => {
      expect(() => face().facing("xy" as never)).toThrow("facing(direction, within): 'xy' is not a direction");
      expect(() => face().notFacing("up" as never)).toThrow("notFacing(direction, within): 'up' is not a direction");
      expect(() => face().facing([0, 0, 0])).toThrow(/facing\(direction, within\): .*zero/);
    });

    it("refuses an angle outside 0 to 180 degrees", () => {
      expect(() => face().facing("z", -1)).toThrow(/within/);
      expect(() => face().facing("z", 181)).toThrow(/within/);
      expect(() => face().notFacing("z", Number.NaN)).toThrow(/within/);
    });
  });

  it("the kind predicates are unchanged by a transform and compare by kind", () => {
    const mirror = Matrix4.mirrorPlane(new Vector3d(1, 0, 0), new Point(0, 0, 0));
    const build = (pick: (b: FaceFilterBuilder) => FaceFilterBuilder) => pick(face()).getFilters()[0];
    const picks: ((b: FaceFilterBuilder) => FaceFilterBuilder)[] = [
      b => b.sphere(), b => b.sphere(12), b => b.notSphere(), b => b.notSphere(12),
      b => b.freeform(), b => b.notFreeform(), b => b.revolved(), b => b.notRevolved(),
      b => b.extruded(), b => b.notExtruded(),
    ];
    for (const pick of picks) {
      const filter = build(pick);
      const moved = filter.transform(mirror);
      expect(moved.constructor).toBe(filter.constructor);
      expect(moved.compareTo(filter)).toBe(true);
    }
    const sized = build(b => b.sphere(12));
    expect(sized.compareTo(build(b => b.sphere(14)))).toBe(false);
  });
});
