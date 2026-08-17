import { describe, it, expect } from "vitest";
import { setupOC } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { AssemblyCompare } from "../rendering/assembly-compare.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Part } from "../features/part.js";
import part from "../core/part.js";
import insert from "../core/insert.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import remove from "../core/remove.js";
import { rect } from "../core/2d/index.js";
import type { Sketch } from "../features/2d/sketch.js";

// Mirrors the server's per-render module reload: every render creates fresh
// part definitions and a fresh assembly scene, then inserts both parts. The
// consumer part references the donor's reusable sketch — the cross-part
// dependency AssemblyCompare must account for.
function buildAssembly(withExtraRect: boolean): AssemblyScene {
  const scene = getSceneManager().startAssemblyScene();
  const donor = part("Donor", () => {
    const s = sketch("xy", () => {
      rect(20, 20);
      if (withExtraRect) {
        rect(5, 5);
      }
    }).reusable();
    return { profile: s as unknown as Sketch };
  });
  const consumer = part("Consumer", () => {
    extrude(15, donor.features.profile);
    remove(donor.features.profile);
  });
  insert(donor);
  insert(consumer);
  return scene;
}

function topPart(scene: AssemblyScene, name: string): Part {
  const found = scene.getAllSceneObjects().find(
    o => o instanceof Part && o.getParent() === null && (o as Part).partName === name,
  );
  if (!found) {
    throw new Error(`No top-level part named ${name}`);
  }
  return found as Part;
}

describe("AssemblyCompare cross-part dependencies", () => {
  setupOC();

  it("keeps both parts cached when nothing changed", () => {
    const scene1 = buildAssembly(false);
    const scene2 = buildAssembly(false);

    const result = AssemblyCompare.compare(scene1, scene2);

    expect(result.isCached(topPart(result, "Donor"))).toBe(true);
    expect(result.isCached(topPart(result, "Consumer"))).toBe(true);
  });

  it("rebuilds a consumer part whose referenced donor sketch changed", () => {
    const scene1 = buildAssembly(false);
    const scene2 = buildAssembly(true);

    const result = AssemblyCompare.compare(scene1, scene2);

    // The donor's own subtree changed — it must rebuild.
    expect(result.isCached(topPart(result, "Donor"))).toBe(false);

    // The consumer's subtree is textually unchanged, but its extrude/remove
    // reference the donor's sketch: serving its cached state would render
    // stale geometry and skip the remove() of the donor's fresh sketch.
    const consumer = topPart(result, "Consumer");
    expect(result.isCached(consumer)).toBe(false);
    for (const child of consumer.getChildren()) {
      expect(result.isCached(child)).toBe(false);
    }
  });
});
