import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { AssemblyCompare } from "../rendering/assembly-compare.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Exposed } from "../features/exposed.js";
import part from "../core/part.js";
import insert from "../core/insert.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import expose from "../core/expose.js";
import select from "../core/select.js";
import { face } from "../filters/index.js";
import { circle } from "../core/2d/index.js";

// Mirrors the server's per-render module reload: each render creates fresh
// part definitions and a fresh assembly scene. The second render compares
// against the first and serves the whole scene from cache — the exposure's
// contact classification must survive that path (it broke: seed came back
// null after any cached assembly re-render, silently killing tangent mates).
function buildAssembly(): AssemblyScene {
  const scene = getSceneManager().startAssemblyScene();
  const cam = part("Cam", () => {
    sketch("xz", () => {
      circle([0, 12], 80);
    });
    extrude(24);
    expose("profile", select(face().notPlanar()));
  });
  insert(cam);
  return scene;
}

function findExposed(scene: AssemblyScene): Exposed {
  const found = scene.getAllSceneObjects().find(o => o instanceof Exposed);
  if (!found) {
    throw new Error("No Exposed object in scene");
  }
  return found as Exposed;
}

describe("Exposed serialization across cached assembly re-renders", () => {
  setupOC();

  it("keeps the contact seed/chain when the whole scene is served from cache", () => {
    const scene1 = buildAssembly();
    getSceneManager().renderScene(scene1);

    const first = findExposed(scene1).serialize();
    expect(first.seed).not.toBeNull();
    expect(first.seed?.form).toBe("cylinder");
    expect(first.chain.length).toBeGreaterThan(0);

    const scene2 = buildAssembly();
    const merged = AssemblyCompare.compare(scene1, scene2);
    getSceneManager().renderScene(merged);

    const exposedObj = findExposed(merged);
    expect(merged.isCached(exposedObj)).toBe(true);

    const second = exposedObj.serialize();
    expect(second.seed).not.toBeNull();
    expect(second.seed?.form).toBe("cylinder");
    expect(second.chain.length).toBeGreaterThan(0);
  });
});
