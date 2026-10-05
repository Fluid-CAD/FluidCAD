import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import copy from "../../core/copy.js";
import axis from "../../core/axis.js";
import { } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { CopyAxisSource, CopyBase } from "../../features/copy-base.js";
import { CopyLayout } from "../../features/copy-layout.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Axis } from "../../math/axis.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { rad } from "../../helpers/math-helpers.js";
import { testRect } from "../helpers/profiles.js";

/**
 * Where one copy lands: its slot, the placed body's bounding-box centre, and
 * the transform that put it there — a translation for a linear copy, a turn
 * in degrees about the row's axis for a circular one.
 */
type Placement = { slot: number; centre: [number, number, number] }
  & ({ move: [number, number, number] } | { turn: number });

type Row = {
  name: string;
  /** Where the 20 × 20 × 10 box's corner sits. */
  at: [number, number];
  copy: (target: SceneObject) => unknown;
  /** The axis a circular row turns about. */
  about?: Axis;
  originalSlot: number;
  slotCount: number;
  placed: Placement[];
};

const offAxis = new Axis(new Point(20, 0, 0), new Vector3d(0, 0, 1));

/**
 * copy()'s slots as `CopyLinear.build` and `CopyCircular.build` placed them
 * before CopyLayout existed, captured from the built shapes (their mesh-source
 * matrices and bounding boxes) on 2026-09-27; CopyLayout reproduces them bit
 * for bit. Slot numbers are the ones `instance(k)` uses elsewhere: a grid
 * linearizes with the first axis slowest and the original in its own cell (the
 * centre cell when `centered`); a circular copy counts rotation steps with the
 * original at 0. A `skip` tuple matches as a prefix, the circular step is
 * angle / count even for a partial arc, and circular `centered` shifts only
 * the copies, so the even-count row below lands one on the original — copy()'s
 * rules, pinned as they are (see plans/connector-copies-bugs.md, B3–B5).
 */
const rows: Row[] = [
  {
    name: "linear, one axis",
    at: [0, 0],
    copy: e => copy("linear", "x", { count: 3, offset: 40 }, e),
    originalSlot: 0,
    slotCount: 3,
    placed: [
      { slot: 1, move: [40, 0, 0], centre: [50, 10, 5] },
      { slot: 2, move: [80, 0, 0], centre: [90, 10, 5] },
    ],
  },
  {
    name: "linear, two axes",
    at: [0, 0],
    copy: e => copy("linear", ["x", "y"], { count: [3, 2], offset: [30, 25] }, e),
    originalSlot: 0,
    slotCount: 6,
    placed: [
      { slot: 1, move: [0, 25, 0], centre: [10, 35, 5] },
      { slot: 2, move: [30, 0, 0], centre: [40, 10, 5] },
      { slot: 3, move: [30, 25, 0], centre: [40, 35, 5] },
      { slot: 4, move: [60, 0, 0], centre: [70, 10, 5] },
      { slot: 5, move: [60, 25, 0], centre: [70, 35, 5] },
    ],
  },
  {
    name: "linear, centered",
    at: [0, 0],
    copy: e => copy("linear", "x", { count: 4, offset: 30, centered: true }, e),
    originalSlot: 2,
    slotCount: 4,
    placed: [
      { slot: 0, move: [-60, 0, 0], centre: [-50, 10, 5] },
      { slot: 1, move: [-30, 0, 0], centre: [-20, 10, 5] },
      { slot: 3, move: [30, 0, 0], centre: [40, 10, 5] },
    ],
  },
  {
    name: "linear, centered grid",
    at: [0, 0],
    copy: e => copy("linear", ["x", "y"], { count: [3, 3], offset: [30, 20], centered: true }, e),
    originalSlot: 4,
    slotCount: 9,
    placed: [
      { slot: 0, move: [-30, -20, 0], centre: [-20, -10, 5] },
      { slot: 1, move: [-30, 0, 0], centre: [-20, 10, 5] },
      { slot: 2, move: [-30, 20, 0], centre: [-20, 30, 5] },
      { slot: 3, move: [0, -20, 0], centre: [10, -10, 5] },
      { slot: 5, move: [0, 20, 0], centre: [10, 30, 5] },
      { slot: 6, move: [30, -20, 0], centre: [40, -10, 5] },
      { slot: 7, move: [30, 0, 0], centre: [40, 10, 5] },
      { slot: 8, move: [30, 20, 0], centre: [40, 30, 5] },
    ],
  },
  {
    // [1, 0] names one cell; [2] is a prefix and names the whole row at x index 2.
    name: "linear, skip",
    at: [0, 0],
    copy: e => copy("linear", ["x", "y"], { count: [3, 2], offset: [30, 25], skip: [[1, 0], [2]] }, e),
    originalSlot: 0,
    slotCount: 6,
    placed: [
      { slot: 1, move: [0, 25, 0], centre: [10, 35, 5] },
      { slot: 3, move: [30, 25, 0], centre: [40, 35, 5] },
    ],
  },
  {
    // A count-1 axis spaces nothing: its offset is 0, not length / 0.
    name: "linear, length with a single-instance axis",
    at: [0, 0],
    copy: e => copy("linear", ["x", "y"], { count: [3, 1], length: [80, 50] }, e),
    originalSlot: 0,
    slotCount: 3,
    placed: [
      { slot: 1, move: [40, 0, 0], centre: [50, 10, 5] },
      { slot: 2, move: [80, 0, 0], centre: [90, 10, 5] },
    ],
  },
  {
    name: "linear, along an axis object",
    at: [0, 0],
    copy: e => copy("linear", axis("y"), { count: 3, offset: 35 }, e),
    originalSlot: 0,
    slotCount: 3,
    placed: [
      { slot: 1, move: [0, 35, 0], centre: [10, 45, 5] },
      { slot: 2, move: [0, 70, 0], centre: [10, 80, 5] },
    ],
  },
  {
    name: "circular, partial angle",
    at: [50, 0],
    copy: e => copy("circular", "z", { count: 4, angle: 90 }, e),
    about: Axis.Z(),
    originalSlot: 0,
    slotCount: 4,
    placed: [
      { slot: 1, turn: 22.5, centre: [51.605938, 32.199801, 5] },
      { slot: 2, turn: 45, centre: [35.355339, 49.497475, 5] },
      { slot: 3, turn: 67.5, centre: [13.722211, 59.259606, 5] },
    ],
  },
  {
    name: "circular, full angle",
    at: [50, 0],
    copy: e => copy("circular", "z", { count: 3, angle: 360 }, e),
    about: Axis.Z(),
    originalSlot: 0,
    slotCount: 3,
    placed: [
      { slot: 1, turn: 120, centre: [-38.660254, 46.961524, 5] },
      { slot: 2, turn: 240, centre: [-21.339746, -56.961524, 5] },
    ],
  },
  {
    name: "circular, offset",
    at: [50, 0],
    copy: e => copy("circular", "z", { count: 3, offset: 45 }, e),
    about: Axis.Z(),
    originalSlot: 0,
    slotCount: 3,
    placed: [
      { slot: 1, turn: 45, centre: [35.355339, 49.497475, 5] },
      { slot: 2, turn: 90, centre: [-10, 60, 5] },
    ],
  },
  {
    name: "circular, skip",
    at: [50, 0],
    copy: e => copy("circular", "z", { count: 6, angle: 360, skip: [2, 4] }, e),
    about: Axis.Z(),
    originalSlot: 0,
    slotCount: 6,
    placed: [
      { slot: 1, turn: 60, centre: [21.339746, 56.961524, 5] },
      { slot: 3, turn: 180, centre: [-60, -10, 5] },
      { slot: 5, turn: 300, centre: [38.660254, -46.961524, 5] },
    ],
  },
  {
    // The copies shift back by half the pattern, and slot 2 lands on the original.
    name: "circular, centered",
    at: [50, 0],
    copy: e => copy("circular", "z", { count: 4, angle: 360, centered: true }, e),
    about: Axis.Z(),
    originalSlot: 0,
    slotCount: 4,
    placed: [
      { slot: 1, turn: -90, centre: [10, -60, 5] },
      { slot: 2, turn: 0, centre: [60, 10, 5] },
      { slot: 3, turn: 90, centre: [-10, 60, 5] },
    ],
  },
  {
    name: "circular, about an off-origin axis",
    at: [50, 0],
    copy: e => copy("circular", offAxis as never, { count: 2, angle: 360 }, e),
    about: offAxis,
    originalSlot: 0,
    slotCount: 2,
    placed: [
      { slot: 1, turn: 180, centre: [-20, -10, 5] },
    ],
  },
  {
    name: "circular, about an axis object",
    at: [50, 0],
    copy: e => copy("circular", axis("z", { offsetX: 20 }), { count: 4, angle: 360 }, e),
    about: offAxis,
    originalSlot: 0,
    slotCount: 4,
    placed: [
      { slot: 1, turn: 90, centre: [10, 40, 5] },
      { slot: 2, turn: 180, centre: [-20, -10, 5] },
      { slot: 3, turn: 270, centre: [30, -40, 5] },
    ],
  },
];

/** The transform a placement states. */
function expectedMatrix(row: Row, placement: Placement): Matrix4 {
  if ("move" in placement) {
    return Matrix4.fromTranslation(...placement.move);
  }
  return Matrix4.fromRotationAroundAxis(row.about!.origin, row.about!.direction, rad(placement.turn));
}

function expectMatrix(actual: Matrix4, expected: Matrix4, label: string): void {
  expect(actual.equals(expected, 1e-9), `${label}: ${actual} vs ${expected}`).toBe(true);
}

describe("copy() slot layout", () => {
  setupOC();

  for (const row of rows) {
    it(`places ${row.name} as before`, () => {
      sketch("xy", () => {
        testRect(20, 20, { at: row.at });
      });
      const e = extrude(10).new() as ExtrudeBase;
      const statement = row.copy(e) as CopyBase;

      // Parse time: the slots are numbered before any axis has built.
      const layout = statement.slotLayout();
      expect(layout.originalSlot).toBe(row.originalSlot);
      expect(layout.slotCount).toBe(row.slotCount);
      expect(layout.slots.map(slot => slot.slot)).toEqual(row.placed.map(placement => placement.slot));

      const scene = render();
      const errored = scene.getAllSceneObjects().filter(o => o.getError());
      expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);

      // The original first, then one body per placed slot in slot order.
      const shapes = statement.getShapes();
      expect(shapes).toHaveLength(1 + row.placed.length);
      row.placed.forEach((placement, k) => {
        const expected = expectedMatrix(row, placement);
        expectMatrix(layout.slots[k].matrix.resolve(), expected, `layout slot ${placement.slot}`);
        const placedShape = shapes[1 + k];
        expectMatrix(placedShape.getMeshSource()!.matrix, expected, `slot ${placement.slot}`);
        const box = ShapeOps.getBoundingBox(placedShape);
        expect(box.centerX).toBeCloseTo(placement.centre[0], 5);
        expect(box.centerY).toBeCloseTo(placement.centre[1], 5);
        expect(box.centerZ).toBeCloseTo(placement.centre[2], 5);
      });
    });
  }
});

describe("CopyLayout", () => {
  setupOC();

  /** An axis object, unbuilt: nothing renders in these tests. */
  function unbuilt(name: "x" | "z"): CopyAxisSource {
    return axis(name) as unknown as CopyAxisSource;
  }

  it("compares linear slot moves structurally, without building an axis", () => {
    const grid = (offset: number) => CopyLayout.linear([unbuilt("x"), Axis.Y()], { count: [2, 2], offset: [offset, 25] });
    const a = grid(30);
    const b = grid(30);
    const c = grid(35);

    expect(a.slots.map(slot => slot.slot)).toEqual([1, 2, 3]);
    a.slots.forEach((slot, i) => {
      expect(slot.matrix.equals(b.slots[i].matrix)).toBe(true);
    });
    // Slot 1 moves along y alone, whatever the x spacing; slots 2 and 3 move along x.
    expect(a.slots[0].matrix.equals(c.slots[0].matrix)).toBe(true);
    expect(a.slots[1].matrix.equals(c.slots[1].matrix)).toBe(false);
  });

  it("compares circular slot moves structurally, without building an axis", () => {
    const ring = (angle: number) => CopyLayout.circular(unbuilt("z"), { count: 4, angle });

    expect(ring(360).slots[1].matrix.equals(ring(360).slots[1].matrix)).toBe(true);
    expect(ring(360).slots[1].matrix.equals(ring(180).slots[1].matrix)).toBe(false);
  });
});
