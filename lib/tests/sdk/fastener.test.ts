// The fastener fixture — the feature with choices — built in the kernel: a
// clearance hole whose size comes from a select and whose head from a radio,
// sunk into a plate at a connector.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { Connector } from "../../features/connector.js";
import type { Feature } from "../../sdk/index.js";
import { fastener, FASTENER_DEFAULTS, FASTENER_SIZES } from "../fixtures/custom-features/fastener.js";

const PLATE = { w: 60, d: 40, t: 12 };
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.t;

const cylinder = (diameter: number, height: number) => Math.PI * (diameter / 2) ** 2 * height;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function solids(scene: Scene) {
  return scene.getSceneObjects().filter(o => !o.isContainer()).flatMap(o => o.getShapes()).filter(sh => sh.isSolid());
}

function volumes(scene: Scene): number[] {
  return solids(scene).map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3).sort((a, b) => a - b);
}

/** Inside a part: a 60 × 40 × 12 plate centred on the origin and a connector at the centre of its top. */
function plateIn(then: (top: Connector) => void): void {
  part("plate", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    extrude(PLATE.t);
    then(connector("top", select(face().planar().onPlane("xy", PLATE.t))) as unknown as Connector);
  });
}

describe("the fastener fixture", () => {
  setupOC();

  it("cuts a plain M3 clearance hole into the plate when its select and radio are left out", () => {
    plateIn(top => {
      fastener(top);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const hole = cylinder(FASTENER_SIZES.m3.clearance, FASTENER_DEFAULTS.depth);
    expect(volumes(scene)).toHaveLength(1);
    expect(volumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - hole, 3);
  });

  it("builds a size its 'when' does not offer for the standard — the dialog narrows, a call owes it nothing", () => {
    plateIn(top => {
      (fastener(top, { size: 'n4', head: 'plain', depth: 8 }) as unknown as Feature).new();
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(volumes(scene)).toHaveLength(2);
  });

  it.each([
    ['counterbore', FASTENER_SIZES.m5.headHeight],
    ['countersink', (FASTENER_SIZES.m5.head - FASTENER_SIZES.m5.clearance) / 2],
  ] as const)("sinks a %s head into one solid, the head's width at the surface", (style, sunk) => {
    const { clearance, head } = FASTENER_SIZES.m5;
    plateIn(top => {
      (fastener(top, { size: 'm5', head: style, depth: 8 }) as unknown as Feature).new();
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(volumes(scene)).toHaveLength(2);
    expect(volumes(scene)[0]).toBeCloseTo(cylinder(clearance, 8 - sunk) + cylinder(head, sunk), 3);
    const box = solids(scene).map(sh => ShapeOps.getExactBoundingBox(sh)).find(b => b.maxX < PLATE.w / 2)!;
    expect([box.minZ, box.maxZ, box.maxX].map(v => Math.round(v * 1000) / 1000)).toEqual([PLATE.t - 8, PLATE.t, head / 2]);
  });

  it("reports a head deeper than the hole on the feature, and refuses a head that is no option", () => {
    let made: Feature | undefined;
    plateIn(top => {
      made = fastener(top, { size: 'm5', head: 'counterbore', depth: 4 }) as unknown as Feature;
      expect(() => fastener(top, { head: 'pan' as 'plain' })).toThrow(`fastener(): 'head' must be one of "plain", "counterbore", "countersink", got 'pan'`);
    });
    render();
    expect(made!.getError()).toContain("fastener: the hole (4) must be deeper than its counterbore (5)");
  });
});
