import { describe, it, expect } from "vitest";
import { setupOC } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { Scene } from "../rendering/scene.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { Part } from "../features/part.js";
import type { PartDefinition } from "../features/part-definition.js";
import part from "../core/part.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import expose from "../core/expose.js";
import { breakpoint } from "../core/breakpoint.js";
import { circle } from "../core/2d/index.js";
import type { IExtrude } from "../core/interfaces.js";
import { testRect } from "./helpers/profiles.js";

/**
 * The server materializes entry-file definitions TWICE per render: the
 * host's export arm calls `materialize()` on every exported definition at
 * module load, then the leftover-definitions pass sweeps whatever has no
 * variant in the scene yet. A `breakpoint()` inside a part body used to
 * abort the build BEFORE the variant cache recorded it, so the second pass
 * re-ran the callback and landed a DUPLICATE partial part in the scene.
 * Mirror both passes exactly (the export arm stops at the first pause, like
 * the host's export loop).
 */
function materializeLikeTheServer(scene: Scene, exported: PartDefinition<unknown>[]): void {
  try {
    for (const def of exported) {
      def.materialize();
    }
  } catch (e) {
    if (!(e instanceof BreakpointHit)) {
      throw e;
    }
  }
  try {
    scene.materializeLeftoverDefinitions();
  } catch (e) {
    if (!(e instanceof BreakpointHit)) {
      throw e;
    }
  }
}

function buildScene(withBreakpoint: boolean): Scene {
  const scene = getSceneManager().startScene();
  const donor = part("Donor", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const e = extrude(30);
    expose("g1", (e as unknown as IExtrude).endFaces(0) as any);
  });
  const consumer = part("Part 1", () => {
    sketch(donor.features.g1 as any, () => {
      // Legacy circle(20) drew at the pen origin = the exposed face's center
      // ([50, 25] local for the 100x50 donor face).
      circle([50, 25], 20);
    });
    if (withBreakpoint) {
      breakpoint();
    }
    extrude(-8);
  });
  materializeLikeTheServer(scene, [donor, consumer] as PartDefinition<unknown>[]);
  return scene;
}

function topParts(scene: Scene): Part[] {
  return scene.getAllSceneObjects().filter(
    o => o instanceof Part && o.getParent() === null,
  ) as Part[];
}

describe("breakpoint inside a part body (double materialization)", () => {
  setupOC();

  it("a paused exported part materializes ONCE across both passes", () => {
    const scene = getSceneManager().startScene();
    const def = part("Solo", () => {
      sketch("xy", () => {
          testRect(10, 10);
        });
      // Cast off `never` — real user files have statements after breakpoint().
      (breakpoint as unknown as () => void)();
      extrude(5);
    });
    materializeLikeTheServer(scene, [def] as PartDefinition<unknown>[]);

    expect(topParts(scene).map(p => p.partName)).toEqual(["Solo"]);
  });

  it("full build has exactly one donor and one consumer", () => {
    const scene = buildScene(false);
    getSceneManager().renderScene(scene);
    expect(topParts(scene).map(p => p.partName).sort()).toEqual(["Donor", "Part 1"]);
  });

  it("the paused re-render keeps one of each part — no duplicates, no drops", () => {
    const s1 = buildScene(false);
    getSceneManager().renderScene(s1);

    const s2 = buildScene(true);
    const merged = getSceneManager().compare(s1, s2);
    getSceneManager().renderScene(merged);

    expect(topParts(merged).map(p => p.partName).sort()).toEqual(["Donor", "Part 1"]);
  });

  it("resuming after the pause converges back to one of each part", () => {
    const s1 = buildScene(false);
    getSceneManager().renderScene(s1);

    const s2 = buildScene(true);
    const merged2 = getSceneManager().compare(s1, s2);
    getSceneManager().renderScene(merged2);

    const s3 = buildScene(false);
    const merged3 = getSceneManager().compare(merged2, s3);
    getSceneManager().renderScene(merged3);

    expect(topParts(merged3).map(p => p.partName).sort()).toEqual(["Donor", "Part 1"]);
  });
});

type DonorBreakpoint = "above-expose" | "below-expose" | "none";

/**
 * The user-facing shape of the donor-pause bug: the DONOR pauses before its
 * `expose()` statement runs, so the consumer's `donor.features.g1` read finds
 * no exposure. That read must re-propagate the pause (both materialization
 * passes already swallow BreakpointHit) — before the fix it returned
 * undefined and the consumer's sketch() failed the whole render with
 * "expected a plane or a scene object".
 */
function buildDonorPauseScene(breakpointAt: DonorBreakpoint): Scene {
  const scene = getSceneManager().startScene();
  const donor = part("Donor", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const e = extrude(30);
    if (breakpointAt === "above-expose") {
      (breakpoint as unknown as () => void)();
    }
    expose("g1", (e as unknown as IExtrude).endFaces(0) as any);
    if (breakpointAt === "below-expose") {
      (breakpoint as unknown as () => void)();
    }
  });
  const consumer = part("Consumer", () => {
    sketch(donor.features.g1 as any, () => {
      circle([50, 25], 20);
    });
    extrude(-8);
  });
  materializeLikeTheServer(scene, [donor, consumer] as PartDefinition<unknown>[]);
  return scene;
}

describe("breakpoint inside the donor part (exposure consumers)", () => {
  setupOC();

  it("a donor paused above its expose() pauses the consumer instead of failing the render", () => {
    // materializeLikeTheServer only swallows BreakpointHit — reaching the
    // assertions at all means the missing exposure paused the consumer
    // rather than throwing the generic invalid-sketch-argument error.
    const scene = buildDonorPauseScene("above-expose");
    getSceneManager().renderScene(scene);

    const parts = topParts(scene);
    expect(parts.map(p => p.partName).sort()).toEqual(["Consumer", "Donor"]);
    expect(parts.find(p => p.partName === "Donor")!.isPaused()).toBe(true);
    expect(parts.find(p => p.partName === "Consumer")!.isPaused()).toBe(true);
  });

  it("a donor paused below its expose() leaves the consumer building fully", () => {
    const scene = buildDonorPauseScene("below-expose");
    getSceneManager().renderScene(scene);

    const consumer = topParts(scene).find(p => p.partName === "Consumer")!;
    expect(consumer.isPaused()).toBe(false);
    // Both consumer features built: the foreign sketch and its extrude.
    expect(consumer.getChildren().length).toBeGreaterThanOrEqual(2);
  });

  it("resuming after a donor pause converges back to one of each part", () => {
    const s1 = buildDonorPauseScene("none");
    getSceneManager().renderScene(s1);

    const s2 = buildDonorPauseScene("above-expose");
    const merged2 = getSceneManager().compare(s1, s2);
    getSceneManager().renderScene(merged2);

    const s3 = buildDonorPauseScene("none");
    const merged3 = getSceneManager().compare(merged2, s3);
    getSceneManager().renderScene(merged3);

    expect(topParts(merged3).map(p => p.partName).sort()).toEqual(["Consumer", "Donor"]);
  });

  it("an undeclared exposure name on a built part throws a pointed error", () => {
    const scene = getSceneManager().startScene();
    const donor = part("Donor", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      expose("g1", (e as unknown as IExtrude).endFaces(0) as any);
    });
    const consumer = part("Consumer", () => {
      sketch((donor.features as Record<string, unknown>).gOne as any, () => {
        circle([50, 25], 20);
      });
    });

    expect(() => materializeLikeTheServer(scene, [donor, consumer] as PartDefinition<unknown>[]))
      .toThrow(/exposes no "gOne" — declared exposures: g1/);
  });
});
