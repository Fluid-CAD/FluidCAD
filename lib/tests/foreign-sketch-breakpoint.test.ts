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
