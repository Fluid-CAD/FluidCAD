// A rendered shape's mesh key (generators S6b, P5) names its mesh payload —
// meshes, vertices, faceVertices — exactly: the same key is always the same
// payload, so a host that holds it need not be sent it again, and anything
// that changes the payload (geometry, triangulation, face colours, the
// topology arrays riding along) changes the key. A shape a compare kept, or
// a generated template taken from the cache, keeps its key across renders.
// render() never throws: every test checks the scene's errors.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneRenderer } from "../../rendering/render.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { MeshKeys } from "../../rendering/mesh-keys.js";
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

/** The pieces part of a key — the triangulation it names. */
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
    expect(solid.meshKey).toMatch(/^[0-9a-f]{8}-[0-9a-z]+\/vf$/);
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

  it("issues ids from one process tag, one per triangulation", () => {
    const { scene } = renderPart(null, () => paintedBox(30));
    const tags = new Set(shapesOf(scene).map(shape => shape.meshKey!.split("-")[0]));
    expect(tags.size).toBe(1);
    const pieces = { faces: [], meshes: [] };
    expect(MeshKeys.piecesId(pieces)).toBe(MeshKeys.piecesId(pieces));
    expect(MeshKeys.piecesId({ faces: [], meshes: [] })).not.toBe(MeshKeys.piecesId(pieces));
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

  it("keeps a generated template's keys when the cache serves it again", () => {
    GeneratedTemplateCache.shared.clear();
    let previous: AssemblyScene | null = null;
    const renderCabinet = (values: Record<string, unknown>): AssemblyScene => {
      const scene = getSceneManager().startAssemblyScene();
      insert(cabinetDef(), values as never);
      if (previous) {
        getSceneManager().compare(previous, scene);
      }
      getSceneManager().renderScene(scene);
      expect(errorsOf(scene)).toEqual([]);
      previous = scene;
      return scene;
    };

    const a = templateKeys(renderCabinet({}));
    expect(Object.keys(a).sort()).toEqual(["carcass", "door", "drawer"]);
    const walnut = templateKeys(renderCabinet({ finish: "walnut" }));
    // The finish reaches the carcass and the doors; the drawers were kept.
    expect(walnut.drawer).toEqual(a.drawer);
    expect(walnut.carcass.some(key => a.carcass.includes(key))).toBe(false);

    // Back to A: the carcass and doors from the cache, under the keys they had.
    const again = renderCabinet({});
    expect(getSceneManager().getGeneratedReport(again).hits).toEqual({ kept: 1, cached: 2 });
    expect(templateKeys(again)).toEqual(a);
  });
});
