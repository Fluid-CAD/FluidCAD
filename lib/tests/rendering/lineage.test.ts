import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { callSiteKey } from "../../common/call-site.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import chamfer from "../../core/chamfer.js";
import shell from "../../core/shell.js";
import cut from "../../core/cut.js";
import split from "../../core/split.js";
import fuse from "../../core/fuse.js";
import subtract from "../../core/subtract.js";
import copy from "../../core/copy.js";
import plane from "../../core/plane.js";
import select from "../../core/select.js";
import { circle } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

// A body's identity is its lineage, not its holder: the feature that created
// it plus its ordinal there, followed through every feature that took it and
// handed its own result on. The key survives the holder moving down the
// timeline (fillet, chamfer, shell, cut) and the re-render that rebuilds every
// holder after an upstream edit — where shape ids, random per Shape, do not.

const FILE = "/ws/bracket.fluid.js";

/** Stamp the source location the real pipeline stamps on every statement. */
function at<T>(obj: T, line: number, column = 0): T {
  (obj as unknown as SceneObject).setSourceLocation({ filePath: FILE, line, column });
  return obj;
}

type Rendered = { holder: SceneObject; shapeId: string; key: string | undefined };

/** Every drawn solid of the render, with its holder and lineage key. */
function solids(scene: Scene): Rendered[] {
  const out: Rendered[] = [];
  for (const row of scene.getRenderedObjects()) {
    const holder = scene.getAllSceneObjects().find(o => o.id === row.id)!;
    for (const shape of row.sceneShapes) {
      if (shape.shapeType === 'solid' && !shape.isMetaShape && !shape.isGuide) {
        out.push({ holder, shapeId: shape.shapeId, key: shape.lineageKey });
      }
    }
  }
  return out;
}

/** The drawn non-solids: sketch wires, datum quads, meta shapes. */
function nonSolids(scene: Scene) {
  return scene.getRenderedObjects().flatMap(row => row.sceneShapes)
    .filter(shape => shape.shapeType !== 'solid' || shape.isMetaShape || shape.isGuide);
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().map(obj => obj.getError()).filter((e): e is string => !!e);
}

/** A clean render: no object errored, every solid keyed, no two solids sharing a key. */
function renderKeyed(): { scene: Scene; solids: Rendered[] } {
  const scene = render();
  expect(errorsOf(scene)).toEqual([]);
  const drawn = solids(scene);
  for (const { key } of drawn) {
    expect(key).toBeDefined();
  }
  expect(new Set(drawn.map(s => s.key)).size).toBe(drawn.length);
  return { scene, solids: drawn };
}

function rootKey(obj: unknown): string {
  return `${callSiteKey(obj as SceneObject)}:1`;
}

/** `sketch; extrude` at lines 1 and 2 — the bracket body, 100 × 50 × 30 about the origin. */
function bracket(width = 100, line = 1) {
  at(sketch("xy", () => { testRect(width, 50, { at: [-width / 2, -25] }); }), line);
  return at(extrude(30), line + 1) as any;
}

describe("body lineage keys", () => {
  setupOC();

  it("keys a solid by its root's call site and ordinal", () => {
    const e = bracket();
    const { solids: [body] } = renderKeyed();

    expect(body.holder).toBe(e);
    expect(body.key).toBe(`extrude@${FILE}:2:0:1`);
    expect(body.key).toBe(rootKey(e));
  });

  it("survives an upstream parameter edit that rebuilds the holder", () => {
    bracket(100);
    const before = renderKeyed();
    const previous = getSceneManager().currentScene;

    getSceneManager().startScene();
    bracket(120);
    SceneCompare.compare(previous, getSceneManager().currentScene);
    const after = renderKeyed();

    expect(after.solids[0].key).toBe(before.solids[0].key);
    // The holder rebuilt: a fresh shape id, which is why ids are no key.
    expect(after.solids[0].shapeId).not.toBe(before.solids[0].shapeId);
  });

  describe("stays with the body when a feature takes it and hands its result on", () => {
    const ops: [string, (e: any) => unknown][] = [
      ["fillet", e => fillet(3, e.endEdges())],
      ["chamfer", () => { at(select(edge().verticalTo("xy")), 3); return chamfer(2); }],
      ["shell", () => { at(select(face().onPlane("xy", 30)), 3); return shell(2); }],
      ["cut", () => { at(sketch(plane("xy", 30), () => { circle([0, 0], 5); }), 3); return cut(35); }],
    ];

    it.each(ops)("%s", (_name, op) => {
      const e = bracket();
      const taker = at(op(e), 4);
      const { solids: drawn } = renderKeyed();

      expect(drawn).toHaveLength(1);
      expect(drawn[0].holder).toBe(taker);
      expect(drawn[0].key).toBe(rootKey(e));
      expect((e as SceneObject).getShapes({}, 'solid')).toHaveLength(0);
    });

    it("across several hops: fillet, then shell, then a cut", () => {
      const e = bracket();
      const f = at(fillet(3, e.endEdges()), 3);
      at(select(face().onPlane("xy", 30)), 4);
      const sh = at(shell(2), 5);
      at(sketch(plane("xy", 30), () => { circle([0, 0], 5); }), 6);
      const k = at(cut(35), 7);
      const { solids: drawn } = renderKeyed();

      expect(drawn).toHaveLength(1);
      expect(drawn[0].holder).toBe(k);
      expect(drawn[0].key).toBe(rootKey(e));
      for (const holder of [e, f, sh]) {
        expect((holder as SceneObject).getShapes({}, 'solid')).toHaveLength(0);
      }
    });
  });

  it("numbers the pieces a split makes of a body", () => {
    const e = bracket();
    const s = at(split("yz"), 3);
    const { solids: drawn } = renderKeyed();

    expect(drawn.map(d => d.holder)).toEqual([s, s]);
    expect(drawn.map(d => d.key)).toEqual([`${rootKey(e)}.1`, `${rootKey(e)}.2`]);
  });

  it("keeps the earlier root for the body two extrudes fuse into", () => {
    const e1 = bracket();
    at(sketch("xy", () => { testRect(100, 50, { at: [0, 0] }); }), 3);
    const e2 = at(extrude(30).new(), 4);
    const f = at(fuse(e1, e2), 5);
    const { solids: drawn } = renderKeyed();

    expect(drawn).toHaveLength(1);
    expect(drawn[0].holder).toBe(f);
    expect(drawn[0].key).toBe(rootKey(e1));
    expect(drawn[0].key).not.toBe(rootKey(e2));
  });

  it("keeps the stock's key through a subtract; the tool's lineage ends", () => {
    const e = bracket();
    at(sketch("xy", () => { circle([0, 0], 10); }), 3);
    const tool = at(extrude(30).new(), 4);
    const s = at(subtract(e, tool), 5);
    const { solids: drawn } = renderKeyed();

    expect(drawn).toHaveLength(1);
    expect(drawn[0].holder).toBe(s);
    expect(drawn[0].key).toBe(rootKey(e));
  });

  it("branches a copy's original into itself and its clones", () => {
    const e = bracket();
    const c = at(copy("linear", "x", { count: 2, offset: 150 }, e), 3);
    const { solids: drawn } = renderKeyed();

    expect(drawn.map(d => d.holder)).toEqual([c, c]);
    expect(drawn.map(d => d.key)).toEqual([`${rootKey(e)}.1`, `${rootKey(e)}.2`]);
  });

  it("tells apart the bodies one call site builds more than once", () => {
    const bodies: SceneObject[] = [];
    for (let i = 0; i < 2; i++) {
      at(sketch("xy", () => { circle([i * 100, 0], 10); }), 1);
      bodies.push(at(extrude(10), 2) as unknown as SceneObject);
    }
    const { solids: drawn } = renderKeyed();

    expect(drawn.map(d => d.holder)).toEqual(bodies);
    expect(drawn.map(d => d.key)).toEqual([`extrude@${FILE}:2:0#0:1`, `extrude@${FILE}:2:0#1:1`]);
  });

  describe("a root's identity", () => {
    it("is its custom name, which survives a statement inserted above it", () => {
      at(sketch("xy", () => { testRect(100, 50); }), 1);
      at(extrude(30).name("bracket"), 2);
      const before = renderKeyed();
      expect(before.solids[0].key).toBe("name:bracket:1");

      getSceneManager().startScene();
      at(plane("xy", 5), 1);
      at(sketch("xy", () => { testRect(100, 50); }), 2);
      at(extrude(30).name("bracket"), 3);
      const after = renderKeyed();

      expect(after.solids[0].key).toBe("name:bracket:1");
    });

    it("is its line when unnamed, so an insertion above moves it (the UI carries that)", () => {
      bracket(100, 1);
      const before = renderKeyed();
      expect(before.solids[0].key).toBe(`extrude@${FILE}:2:0:1`);

      getSceneManager().startScene();
      at(plane("xy", 5), 1);
      bracket(100, 2);
      const after = renderKeyed();

      expect(after.solids[0].key).toBe(`extrude@${FILE}:3:0:1`);
    });

    it("falls back to the object id when nothing was stamped", () => {
      sketch("xy", () => { testRect(100, 50); });
      const e = extrude(30) as unknown as SceneObject;
      const { solids: [body] } = renderKeyed();

      expect(body.key).toBe(`id:${e.id}:1`);
    });
  });

  it("keys solids only — sketch wires and datum meta shapes carry none", () => {
    at(plane("xy", 5), 1);
    at(sketch("xy", () => { testRect(100, 50); }), 2);
    at(extrude(30), 3);
    const { scene } = renderKeyed();

    const others = nonSolids(scene);
    expect(others.length).toBeGreaterThan(0);
    for (const shape of others) {
      expect(shape.lineageKey).toBeUndefined();
    }
  });

  it("keys the body where a rollback view leaves it", () => {
    const e = bracket();
    at(fillet(3, e.endEdges()), 3);
    const { scene } = renderKeyed();
    const rows = scene.getTimelineObjects();

    getSceneManager().rollbackScene(scene, rows.indexOf(e));
    const drawn = solids(scene);

    expect(drawn).toHaveLength(1);
    expect(drawn[0].holder).toBe(e);
    expect(drawn[0].key).toBe(rootKey(e));
  });
});
