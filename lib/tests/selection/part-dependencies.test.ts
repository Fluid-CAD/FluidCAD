import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import part from "../../core/part.js";
import expose from "../../core/expose.js";
import { Part } from "../../features/part.js";
import { PartDependencies, resolvePartDependency } from "../../selection/part-dependencies.js";
import { setLocation } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

const FILE = "/ws/model.fluid.js";
const at = (line: number) => ({ filePath: FILE, line });

describe("PartDependencies", () => {
  setupOC();

  /**
   * construct (line 2) exposes its top face; back_door (line 10) sketches
   * on it; latch (line 20) sketches on back_door's exposure; loose (line
   * 30) reads nothing.
   */
  function makeChainScene() {
    const construct = part("construct", () => {
      const e = extrude(10, sketch("xy", () => { testRect(100, 50); }));
      expose("g6", e.endFaces());
    });
    setLocation(construct, 2);
    const backDoor = part("back_door", () => {
      const e = extrude(5, sketch(construct.features.g6, () => { testRect(10, 10); }));
      expose("g1", e.endFaces());
    });
    setLocation(backDoor, 10);
    const latch = part("latch", () => {
      extrude(2, sketch(backDoor.features.g1, () => { testRect(2, 2); }));
    });
    setLocation(latch, 20);
    const loose = part("loose", () => {
      extrude(2, sketch("xy", () => { testRect(3, 3, { at: [200, 200] }); }));
    });
    setLocation(loose, 30);
    return render();
  }

  function named(scene: ReturnType<typeof render>, name: string): Part {
    return scene.getAllSceneObjects().find(o => o instanceof Part && o.partName === name) as Part;
  }

  it("records a sketch-on-exposure as the consumer building from the donor", () => {
    const scene = makeChainScene();
    const graph = new PartDependencies(scene);
    expect(graph.readBy(named(scene, "back_door")).map(p => p.partName)).toEqual(["construct"]);
    expect(graph.readBy(named(scene, "construct"))).toEqual([]);
    expect(graph.readBy(named(scene, "loose"))).toEqual([]);
  });

  it("follows the chain transitively and reports the shortest path", () => {
    const scene = makeChainScene();
    const graph = new PartDependencies(scene);
    const path = graph.pathBetween(named(scene, "latch"), named(scene, "construct"));
    expect(path?.map(p => p.partName)).toEqual(["latch", "back_door", "construct"]);
    expect(graph.pathBetween(named(scene, "construct"), named(scene, "latch"))).toBe(null);
    expect(graph.pathBetween(named(scene, "loose"), named(scene, "construct"))).toBe(null);
    expect(graph.pathBetween(named(scene, "latch"), named(scene, "latch"))).toBe(null);
  });

  it("counts a boundary reference (a cut up to another part's face) as building from it", () => {
    const stop = part("Stop", () => {
      const e = extrude(10, sketch("xy", () => { testRect(100, 50, { at: [0, 100] }); }));
      expose("top", e.endFaces());
    });
    setLocation(stop, 2);
    const block = part("Block", () => {
      extrude(30, sketch("xy", () => { testRect(20, 20); }));
      cut(stop.features.top, sketch("xy", () => { testRect(5, 5); }));
    });
    setLocation(block, 10);
    const scene = render();
    const graph = new PartDependencies(scene);
    expect(graph.readBy(named(scene, "Block")).map(p => p.partName)).toEqual(["Stop"]);
  });

  it("resolves sites to parts and answers in part names", () => {
    const scene = makeChainScene();
    expect(resolvePartDependency(scene, at(10), at(2))).toEqual(["back_door", "construct"]);
    expect(resolvePartDependency(scene, at(20), at(2))).toEqual(["latch", "back_door", "construct"]);
    expect(resolvePartDependency(scene, at(2), at(10))).toBe(null);
    expect(resolvePartDependency(scene, at(30), at(2))).toBe(null);
    // A site no rendered part() carries is no dependency of anything.
    expect(resolvePartDependency(scene, at(99), at(2))).toBe(null);
    expect(resolvePartDependency(scene, at(10), { filePath: "/ws/other.fluid.js", line: 2 })).toBe(null);
  });

  it("resolves to null in assembly scenes through the scene manager", () => {
    const scene = getSceneManager().startAssemblyScene();
    expect(getSceneManager().resolvePartDependency(scene, at(1), at(2))).toBe(null);
  });
});
