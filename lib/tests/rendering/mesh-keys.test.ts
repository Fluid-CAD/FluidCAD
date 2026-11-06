// A rendered shape's mesh key (generators S6b, P5) names its mesh payload —
// meshes, vertices, faceVertices — by content: the same key is always the
// same payload, so a host that holds it need not be sent it again, and
// anything that changes the payload (geometry, triangulation, face colours,
// the topology arrays riding along) changes the key. A shape a compare
// kept, a generated template taken from the cache — and a shape rebuilt
// into the very same mesh — keeps its key across renders.
// render() never throws: every test checks the scene's errors.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneRenderer } from "../../rendering/render.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { MeshKeys } from "../../rendering/mesh-keys.js";
import { MeshPieces } from "../../rendering/mesh-pieces.js";
import { Scene, type RenderedShape } from "../../rendering/scene.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { AssemblyCompare } from "../../rendering/assembly-compare.js";
import { GeneratedTemplateCache } from "../../rendering/generated-template-cache.js";
import { Part } from "../../features/part.js";
import { Extrude } from "../../features/extrude.js";
import { Translate } from "../../features/translate.js";
import type { SceneObject } from "../../common/scene-object.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import select from "../../core/select.js";
import translate from "../../core/translate.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { defineAssembly } from "../../sdk/index.js";
import type { GeneratedAssemblyDefinition } from "../../sdk/define-assembly.js";
import { defineCabinet } from "../fixtures/custom-features/cabinet.js";
import { testRect } from "../helpers/profiles.js";

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** Every shape a render sent, by row. */
function shapesOf(scene: Scene): RenderedShape[] {
  return scene.getRenderedObjects().flatMap(row => row.sceneShapes);
}

/** The one solid `obj`'s row sent. */
function solidOf(scene: Scene, obj: SceneObject): RenderedShape {
  const row = scene.getRenderedObject(obj);
  expect(row).not.toBeNull();
  const solids = row!.sceneShapes.filter(shape => shape.shapeType === "solid");
  expect(solids).toHaveLength(1);
  return solids[0];
}

/** What a key names: the payload a host would hold under it. */
function payloadOf(shape: RenderedShape): unknown {
  return { meshes: shape.meshes, vertices: shape.vertices, faceVertices: shape.faceVertices };
}

/** The geometry part of a key — the triangulation and topology it names. */
function piecesOf(key: string): string {
  return key.split("/")[0];
}

/** A 100×50 box `height` tall, its top face painted `paint` when given — the code a host evaluates each render. */
function paintedBox(height: number, paint?: string): { body: SceneObject } {
  sketch("xy", () => {
    testRect(100, 50);
  });
  const body = extrude(height) as Extrude;
  if (paint) {
    select(face().onPlane("xy", height));
    color(paint);
  }
  return { body };
}

/** A part scene of `build`, compared against `previous` as the server does, rendered. */
function renderPart<T>(previous: Scene | null, build: () => T): { scene: Scene; built: T } {
  const scene = getSceneManager().startScene();
  const built = build();
  const current = previous ? getSceneManager().compare(previous, scene) : scene;
  render();
  expect(errorsOf(current)).toEqual([]);
  return { scene: current, built };
}

describe("mesh keys", () => {
  setupOC();

  it("gives every meshed shape a key naming its payload's form", () => {
    const { scene, built } = renderPart(null, () => paintedBox(30));
    const solid = solidOf(scene, built.body);
    expect(solid.meshKey).toMatch(/^[0-9a-z]{21}\/vf$/);
    // Every shape with meshes has one, and no two shapes of a render share a key.
    const keyed = shapesOf(scene).filter(shape => shape.meshes);
    expect(keyed.every(shape => typeof shape.meshKey === "string")).toBe(true);
    expect(new Set(keyed.map(shape => shape.meshKey)).size).toBe(keyed.length);
  });

  it("keeps a kept shape's key across renders, naming an equal payload", () => {
    const first = renderPart(null, () => paintedBox(30));
    const firstSolid = solidOf(first.scene, first.built.body);
    const second = renderPart(first.scene, () => paintedBox(30));
    expect(second.scene.isCached(second.built.body)).toBe(true);
    const secondSolid = solidOf(second.scene, second.built.body);
    expect(secondSolid.meshKey).toBe(firstSolid.meshKey);
    expect(payloadOf(secondSolid)).toEqual(payloadOf(firstSolid));
    // The whole scene: every key the first render sent, the second sent again.
    expect(shapesOf(second.scene).map(shape => shape.meshKey)).toEqual(shapesOf(first.scene).map(shape => shape.meshKey));
  });

  it("changes the key when the geometry changes", () => {
    const first = renderPart(null, () => paintedBox(30));
    const taller = renderPart(first.scene, () => paintedBox(40));
    expect(taller.scene.isCached(taller.built.body)).toBe(false);
    const before = solidOf(first.scene, first.built.body).meshKey!;
    const after = solidOf(taller.scene, taller.built.body).meshKey!;
    expect(piecesOf(after)).not.toBe(piecesOf(before));
  });

  it("changes the key when a face colour changes, over the same triangulation", () => {
    const plain = renderPart(null, () => paintedBox(30));
    const red = renderPart(plain.scene, () => paintedBox(30, "red"));
    const blue = renderPart(red.scene, () => paintedBox(30, "blue"));
    const redAgain = renderPart(blue.scene, () => paintedBox(30, "red"));
    const keys = [plain, red, blue, redAgain].map(r => solidOf(r.scene, r.built.body).meshKey!);

    // The extrude was kept throughout: one triangulation, grouped by colour.
    expect(blue.scene.isCached(blue.built.body)).toBe(true);
    expect(new Set(keys.map(piecesOf)).size).toBe(1);
    expect(keys[0]).toMatch(/\/vf$/);
    expect(keys[1]).toMatch(/\/vf\/[0-9a-f]{14}$/);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    // The same colours again: the same key, the same payload.
    expect(keys[3]).toBe(keys[1]);
    expect(payloadOf(solidOf(redAgain.scene, redAgain.built.body))).toEqual(payloadOf(solidOf(red.scene, red.built.body)));
  });

  it("keys a rollback before the paint as the unpainted payload", () => {
    const red = renderPart(null, () => paintedBox(30, "red"));
    const painted = solidOf(red.scene, red.built.body).meshKey!;
    const index = red.scene.getTimelineObjects().indexOf(red.built.body);
    const rolled = new SceneRenderer(DEFAULT_MESH_CONFIG).renderRollback(red.scene, index);
    const unpainted = solidOf(rolled, red.built.body).meshKey!;
    expect(unpainted).toBe(`${piecesOf(painted)}/vf`);
    expect(solidOf(rolled, red.built.body).meshes!.every(mesh => mesh.color === undefined)).toBe(true);
  });

  it("gives a moved copy its own key, kept across renders", () => {
    const build = () => {
      const { body } = paintedBox(30);
      const moved = translate(200, 0, 0, true, body) as Translate;
      return { body, moved };
    };
    const first = renderPart(null, build);
    const second = renderPart(first.scene, build);
    const original = solidOf(second.scene, second.built.body).meshKey!;
    const copy = solidOf(second.scene, second.built.moved).meshKey!;
    expect(copy).not.toBe(original);
    expect(copy).toBe(solidOf(first.scene, first.built.moved).meshKey);
  });

  it("names the topology arrays a meta shape leaves out", () => {
    const { scene } = renderPart(null, () => paintedBox(30));
    for (const shape of shapesOf(scene)) {
      const form = shape.meshKey!.split("/")[1];
      expect(form).toBe(`${shape.vertices ? "v" : ""}${shape.faceVertices ? "f" : ""}` || "-");
    }
  });

  it("names content: a model rebuilt from scratch gets the keys it had, another model other keys", () => {
    const first = renderPart(null, () => paintedBox(30));
    // No compare: every shape is built again — a new wrapper, the same mesh.
    const again = renderPart(null, () => paintedBox(30));
    expect(again.scene.isCached(again.built.body)).toBe(false);
    expect(shapesOf(again.scene).map(shape => shape.meshKey)).toEqual(shapesOf(first.scene).map(shape => shape.meshKey));
    const other = renderPart(null, () => paintedBox(31));
    expect(solidOf(other.scene, other.built.body).meshKey).not.toBe(solidOf(first.scene, first.built.body).meshKey);
  });

  it("tells apart payloads differing in one number, one flag, or where an array ends", () => {
    const mesh = { label: "solid-edges", vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1], edgeIndex: 0 };
    const keyOf = (meshes: any[], vertices?: number[]) => MeshKeys.of(MeshPieces.ofMeshes(meshes), { vertices, faceColors: null });
    const base = keyOf([mesh], [0, 0, 0]);
    expect(keyOf([{ ...mesh }], [0, 0, 0])).toBe(base);
    expect(keyOf([{ ...mesh, vertices: [0, 0, 0, 1, 0, 1e-12] }], [0, 0, 0])).not.toBe(base);
    expect(keyOf([{ ...mesh, vertices: [0, 0, 0, -1, 0, 0] }], [0, 0, 0])).not.toBe(base);
    expect(keyOf([{ ...mesh, smooth: true }], [0, 0, 0])).not.toBe(base);
    expect(keyOf([{ ...mesh, edgeIndex: 1 }], [0, 0, 0])).not.toBe(base);
    expect(keyOf([{ ...mesh, color: "#ff0000" }], [0, 0, 0])).not.toBe(base);
    expect(keyOf([mesh], [0, 0, 1])).not.toBe(base);
    expect(keyOf([mesh])).toMatch(/\/-$/);
    // One mesh of two vertices and one of one, versus the other way round.
    const split = (a: number[], b: number[]) => keyOf([{ ...mesh, vertices: a }, { ...mesh, vertices: b }]);
    expect(split([1, 2, 3, 4, 5, 6], [7, 8, 9])).not.toBe(split([1, 2, 3], [4, 5, 6, 7, 8, 9]));
  });
});

describe("mesh keys across assembly renders", () => {
  setupOC();

  function topPart(scene: AssemblyScene, name: string): Part {
    return scene.getAllSceneObjects().find(
      (o): o is Part => o instanceof Part && o.getParent() === null && o.partName === name,
    )!;
  }

  /** The keys of every shape `root`'s subtree sent. */
  function keysUnder(scene: Scene, root: SceneObject): string[] {
    const rows: string[] = [];
    const walk = (obj: SceneObject) => {
      for (const shape of scene.getRenderedObject(obj)?.sceneShapes ?? []) {
        rows.push(shape.meshKey!);
      }
      for (const child of obj.getChildren()) {
        walk(child);
      }
    };
    walk(root);
    return rows;
  }

  /** Two parts, inserted; the plate `plate` thick — the module as each render evaluates it. */
  function buildAssembly(plate: number): AssemblyScene {
    const scene = getSceneManager().startAssemblyScene();
    const block = part("Block", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(15);
      select(face().onPlane("xy", 15));
      color("steelblue");
    });
    const base = part("Plate", () => {
      sketch("xy", () => { testRect(60, 40); });
      extrude(plate);
    });
    insert(block);
    insert(base);
    return scene;
  }

  it("keeps the keys of a part AssemblyCompare kept, and changes the rebuilt part's", () => {
    const first = buildAssembly(5);
    render();
    expect(errorsOf(first)).toEqual([]);
    const blockKeys = keysUnder(first, topPart(first, "Block"));
    const plateKeys = keysUnder(first, topPart(first, "Plate"));
    expect(blockKeys.length).toBeGreaterThan(0);

    const second = AssemblyCompare.compare(first, buildAssembly(8));
    render();
    expect(errorsOf(second)).toEqual([]);
    expect(second.isCached(topPart(second, "Block"))).toBe(true);
    expect(keysUnder(second, topPart(second, "Block"))).toEqual(blockKeys);
    expect(second.isCached(topPart(second, "Plate"))).toBe(false);
    const rebuilt = keysUnder(second, topPart(second, "Plate"));
    expect(rebuilt.some(key => plateKeys.includes(key))).toBe(false);
  });

  /** The cabinet as its module defines it on each render — a new class and definition. */
  function cabinetDef(): GeneratedAssemblyDefinition<any> {
    const { Cabinet } = defineCabinet();
    return new Function("defineAssembly", "Cabinet", `return defineAssembly(Cabinet, { label: 'Cabinet' });\n//# sourceURL=/ws/assemblies/cabinet.assembly.js`)(
      defineAssembly, Cabinet,
    ) as GeneratedAssemblyDefinition<any>;
  }

  /** The generated parts' keys of a render, by part type. */
  function templateKeys(scene: AssemblyScene): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const obj of scene.getAllSceneObjects()) {
      if (obj instanceof Part && obj.generatedBy && obj.getParent() === null) {
        out[obj.generatedBy.type] = keysUnder(scene, obj);
      }
    }
    return out;
  }

  /** Renders of the cabinet as a host runs them: each compared against the one before. */
  function cabinetSession(): (values: Record<string, unknown>, detail?: "preview" | "full") => AssemblyScene {
    GeneratedTemplateCache.shared.clear();
    let previous: AssemblyScene | null = null;
    return (values, detail = "full") => {
      const scene = getSceneManager().startAssemblyScene({ detail });
      insert(cabinetDef(), values as never);
      if (previous) {
        getSceneManager().compare(previous, scene);
      }
      getSceneManager().renderScene(scene);
      expect(errorsOf(scene)).toEqual([]);
      previous = scene;
      return scene;
    };
  }

  it("keeps a generated template's keys when the cache serves it again, and changes them with its geometry", () => {
    const renderCabinet = cabinetSession();
    const a = templateKeys(renderCabinet({}));
    expect(Object.keys(a).sort()).toEqual(["carcass", "door", "drawer"]);
    const wide = renderCabinet({ width: 800 });
    expect(getSceneManager().getGeneratedReport(wide).misses).toBe(3);
    const wideKeys = templateKeys(wide);
    // Their solids are other meshes now (a connector's centre mark may stay where it was).
    const solids = (keys: string[]) => keys.filter(key => key.endsWith("/vf"));
    for (const type of ["carcass", "door", "drawer"]) {
      expect(solids(wideKeys[type])).toHaveLength(1);
      expect(solids(a[type])).not.toEqual(solids(wideKeys[type]));
    }

    // Back to A: every template from the cache, under the keys it had.
    const again = renderCabinet({});
    expect(getSceneManager().getGeneratedReport(again).hits).toEqual({ kept: 0, cached: 3 });
    expect(templateKeys(again)).toEqual(a);
  });

  it("keeps the keys of a template rebuilt into the same mesh: another finish, another detail tier", () => {
    const renderCabinet = cabinetSession();
    const a = templateKeys(renderCabinet({}));
    // The finish is the carcass's and the doors' appearance — not their mesh.
    const walnut = renderCabinet({ finish: "walnut" });
    expect(getSceneManager().getGeneratedReport(walnut).misses).toBe(2);
    expect(templateKeys(walnut)).toEqual(a);
    // The fixture builds the same boxes at either tier.
    const preview = renderCabinet({ finish: "walnut" }, "preview");
    expect(getSceneManager().getGeneratedReport(preview).misses).toBe(3);
    expect(templateKeys(preview)).toEqual(a);
  });

  it("gives two parts of equal geometry one key", () => {
    getSceneManager().startAssemblyScene();
    const left = part("Left", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(15);
    });
    const right = part("Right", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(15);
    });
    insert(left);
    insert(right);
    const scene = render() as AssemblyScene;
    expect(errorsOf(scene)).toEqual([]);
    const solids = (name: string) => keysUnder(scene, topPart(scene, name)).filter(key => key.endsWith("/vf"));
    expect(solids("Left")).toHaveLength(1);
    expect(solids("Left")).toEqual(solids("Right"));
  });
});
