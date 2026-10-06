import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import draft from "../../core/draft.js";
import select from "../../core/select.js";
import repeat from "../../core/repeat.js";
import * as core from "../../core/index.js";
import { } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Draft } from "../../features/draft.js";
import { Extrude } from "../../features/extrude.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Scene } from "../../rendering/scene.js";
import { getSceneManager } from "../../scene-manager.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { DraftOps } from "../../oc/draft-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { buildFeatureGhost, type CustomGhostRequest, type FeatureGhostResult } from "../../rendering/feature-ghost.js";
import { resolveFeatureSources } from "../../selection/feature-sources.js";
import type { SelectionBoundary } from "../../selection/types.js";
import { getFeatureMeta, listFeatureExports, snapshotFeatureMeta } from "../../index.js";
import { testRect } from "../helpers/profiles.js";
import { faceRefsWhere, setLocation } from "../selection/pick-helpers.js";

const FILE = '/ws/model.fluid.js';

/** tan(angle°) × 80: how far an 80-high wall drafted by `angle` leans out at its top. */
const lean = (angle: number) => Math.tan(angle * Math.PI / 180) * 80;

/** A 100 × 100 × 80 block at the origin, its extrude at line 2. */
function block(): Extrude {
  sketch("xy", () => {
    testRect(100, 100);
  });
  const e = extrude(80) as Extrude;
  setLocation(e, 2);
  return e;
}

/** The solid the object at `line` added — still there to pick, whatever replaced it since. */
function solidAt(scene: Scene, line: number): Shape {
  const owner = scene.getAllSceneObjects()
    .find(o => o.getSourceLocation()?.line === line && o.getAddedShapes().some(s => s.isSolid()));
  expect(owner).toBeDefined();
  return owner!.getAddedShapes().find(s => s.isSolid())!;
}

/** The block's front face (y = 0), as a ghost ref. */
function frontOf(solid: Shape) {
  const [front] = faceRefsWhere(solid, mid => Math.abs(mid.y) < 1e-6);
  expect(front).toBeDefined();
  return { shapeId: front.shapeId, index: front.sub.index, kind: 'face' as const };
}

/** The volume of every solid the scene renders, smallest first. */
function volumes(scene: Scene): number[] {
  const scope = new Set(scene.getAllSceneObjects());
  const solids = new Set(scene.getAllSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes(undefined, 'solid', scope)));
  return [...solids].map(s => ShapeProps.getProperties(s.getShape()).volumeMm3).sort((a, b) => a - b);
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().map(o => o.getError()).filter((e): e is string => e !== null);
}

function ghost(scene: Scene, request: Partial<Omit<CustomGhostRequest, 'feature' | 'builder'>>): FeatureGhostResult {
  return buildFeatureGhost(scene, { feature: 'custom', builder: draft, values: {}, refs: {}, operation: null, ...request }, DEFAULT_MESH_CONFIG);
}

/** The extent along `axis` (0 x, 1 y, 2 z) of every mesh a ghost answered with. */
function range(result: FeatureGhostResult, axis: 0 | 1 | 2): { min: number; max: number } {
  expect(result).toMatchObject({ ok: true });
  let min = Infinity;
  let max = -Infinity;
  for (const solid of (result as Extract<FeatureGhostResult, { ok: true }>).solids) {
    for (const mesh of solid.meshes) {
      const vertices = (mesh as { vertices: number[] }).vertices;
      for (let i = axis; i < vertices.length; i += 3) {
        min = Math.min(min, vertices[i]);
        max = Math.max(max, vertices[i]);
      }
    }
  }
  return { min, max };
}

function boundaryOf(scene: Scene, line: number): SelectionBoundary {
  const index = scene.getAllSceneObjects().findIndex(o => o.getType() === 'draft' && o.getSourceLocation()?.line === line);
  expect(index).toBeGreaterThanOrEqual(0);
  return { index, type: 'draft', line, column: 0 };
}

describe("draft, written on the Feature base", () => {
  setupOC();

  it("carries metadata, and the core's exports list it the way a feature module's are listed", () => {
    const meta = getFeatureMeta(draft)!;
    expect(meta.class).toBe(Draft);
    expect(listFeatureExports(core).map(entry => entry.exportName)).toEqual(['draft']);
    expect(snapshotFeatureMeta(meta)).toEqual({
      id: 'draft',
      label: 'Draft',
      description: 'Tilts faces by an angle about the bottom of their solid — outward for a positive angle, inward for a negative one.',
      group: 'modify',
      kind: 'modifier',
      operations: [],
      defaultOperation: null,
      params: {
        angle: { type: 'angle', label: 'Angle', default: 5 },
        faces: { picker: 'face', label: 'Faces', multiple: true },
      },
      call: ['angle', '...faces'],
      ghost: true,
      contexts: ['part'],
      // Derived: draft declares no layout, no group, no tab.
      layout: ['angle', 'faces'],
    });
  });

  it("reads every form a model writes it in, its values saying what it drafts", () => {
    /** Build `write` on a fresh block, render, and hand back its draft with no error anywhere. */
    const drafted = (write: (e: Extrude) => unknown): Draft => {
      getSceneManager().startScene();
      const d = write(block()) as Draft;
      const scene = render();
      expect(errorsOf(scene)).toEqual([]);
      expect(d).toBeInstanceOf(Draft);
      expect(scene.getRenderedObject(d)!.name).toBe('Draft');
      return d;
    };
    let picked: unknown = null;

    const explicit = drafted(e => draft(5, e.sideFaces(0), e.sideFaces(2)));
    expect(explicit.values.angle).toBe(5);
    expect(explicit.values.faces).toHaveLength(2);

    // `draft(7)` drafts the last selection.
    const implicit = drafted(() => {
      picked = select(face().onPlane("front"));
      return draft(7);
    });
    expect(implicit.values).toEqual({ angle: 7, faces: [picked] });

    // `draft()` drafts it by 5°.
    const bare = drafted(() => {
      picked = select(face().onPlane("front"));
      return (draft as unknown as () => Draft)();
    });
    expect(bare.values).toEqual({ angle: 5, faces: [picked] });

    // `draft(e.sideFaces())` too: the angle may be left out ahead of the faces.
    const angleless = drafted(e => (draft as unknown as (f: unknown) => Draft)(e.sideFaces(1)));
    expect(angleless.values.angle).toBe(5);
    expect(angleless.values.faces).toHaveLength(1);
  });

  it("fails on its own row when there is nothing to draft, the model building on", () => {
    sketch("xy", () => {
      testRect(40, 30);
    });
    const e = extrude(25) as unknown as SceneObject;
    const d = draft(7) as unknown as SceneObject;
    const scene = render();

    expect(d.getError()).toBe('draft() has no faces to draft — pass them, as in draft(5, e.sideFaces()), or select them just before');
    expect(e.getError()).toBeNull();
    expect(volumes(scene)[0]).toBeCloseTo(30000, 4);
  });

  it("refuses an angle that is not a number where the model calls it", () => {
    const e = block();
    expect(() => (draft as unknown as (a: unknown, f: unknown) => void)('5', e.sideFaces()))
      .toThrow("draft(): 'angle' must be a number, got '5'");
  });

  it("matches a draft of the same values built again, and misses another angle or other faces", () => {
    const build = (angle: number, index: number) => {
      getSceneManager().startScene();
      const e = block();
      const d = draft(angle, e.sideFaces(index)) as unknown as SceneObject;
      render();
      return d;
    };
    const first = build(5, 0);
    expect(first.compareTo(build(5, 0))).toBe(true);
    expect(first.compareTo(build(6, 0))).toBe(false);
    expect(first.compareTo(build(5, 1))).toBe(false);
  });

  it("repeats with its solid, each copy drafted", () => {
    sketch("xy", () => {
      testRect(40, 40);
    });
    const e = extrude(30) as Extrude;
    const d = draft(6, e.sideFaces());
    repeat("linear", "x", { count: 3, offset: 60 }, e, d);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const each = volumes(scene);
    expect(each).toHaveLength(3);
    for (const volume of each) {
      expect(volume).toBeCloseTo(55965.1934, 2);
    }
  });

  describe("its preview", () => {
    it("draws the faces it would tilt, and nothing else", () => {
      block();
      const scene = render();
      const front = frontOf(solidAt(scene, 2));

      const five = ghost(scene, { values: { angle: 5 }, refs: { faces: [{ kind: 'entities', entities: [front] }] } });
      const [tilted] = (five as Extract<FeatureGhostResult, { ok: true }>).solids;
      expect((five as Extract<FeatureGhostResult, { ok: true }>).solids).toHaveLength(1);
      // A face drawn the way the dialog's overlay draws a body: its triangles, then its outline.
      expect(tilted.meshes.map(mesh => (mesh as { label?: string }).label))
        .toEqual(['solid-faces', 'solid-edges', 'solid-edges', 'solid-edges', 'solid-edges']);
      expect(range(five, 1).min).toBeCloseTo(-lean(5), 3);
      expect(range(five, 1).max).toBeCloseTo(0, 3);
      expect(range(five, 2)).toEqual({ min: expect.closeTo(0, 3), max: expect.closeTo(80, 3) });

      // The angle left out is the default; another one leans further.
      expect(range(ghost(scene, { refs: { faces: [{ kind: 'entities', entities: [front] }] } }), 1).min).toBeCloseTo(-lean(5), 3);
      expect(range(ghost(scene, { values: { angle: 10 }, refs: { faces: [{ kind: 'entities', entities: [front] }] } }), 1).min)
        .toBeCloseTo(-lean(10), 3);
    });

    it("reads a face selection statement by its call site", () => {
      block();
      const front = select(face().onPlane("front"));
      setLocation(front, 3);
      const scene = render();

      const result = ghost(scene, { values: { angle: 5 }, refs: { faces: [{ kind: 'statement', filePath: FILE, line: 3 }] } });
      expect(range(result, 1).min).toBeCloseTo(-lean(5), 3);
    });

    it("reads the solids as they stood before the edited draft", () => {
      const e = block();
      const d = draft(5, e.sideFaces()) as unknown as SceneObject;
      setLocation(d, 3);
      const scene = render();
      expect(d.getError()).toBeNull();
      const front = frontOf(solidAt(scene, 2));

      // At the end of the model the draft replaced that solid: no face to tilt.
      expect(ghost(scene, { refs: { faces: [{ kind: 'entities', entities: [front] }] } }))
        .toEqual({ ok: false, reason: 'draft(): none of the faces is on a solid the draft can reach' });

      // Edit mode reads the block as it stood before the draft.
      const edited = ghost(scene, {
        values: { angle: 10 },
        refs: { faces: [{ kind: 'entities', entities: [front] }] },
        exclude: { filePath: FILE, line: 3 },
      });
      expect(range(edited, 1).min).toBeCloseTo(-lean(10), 3);
    });

    it("frees the faces it drew, and leaves the model as it was", () => {
      block();
      const scene = render();
      const before = volumes(scene);
      const solid = solidAt(scene, 2);
      const drawn: Shape[] = [];
      const draftedFaces = DraftOps.draftedFaces.bind(DraftOps);
      const spy = vi.spyOn(DraftOps, 'draftedFaces').mockImplementation((...args) => {
        const faces = draftedFaces(...args);
        drawn.push(...(faces ?? []));
        return faces;
      });
      try {
        expect(ghost(scene, { values: { angle: 5 }, refs: { faces: [{ kind: 'entities', entities: [frontOf(solid)] }] } }).ok).toBe(true);
      } finally {
        spy.mockRestore();
      }

      expect(drawn).toHaveLength(1);
      expect(drawn[0].isReleased()).toBe(true);
      expect(solid.isReleased()).toBe(false);
      expect(volumes(scene)).toEqual(before);
      expect(errorsOf(render())).toEqual([]);
    });
  });

  describe("its sources", () => {
    it("seed the faces it was handed, and the last selection it took itself", () => {
      const e = block();
      const d = draft(5, e.sideFaces(0)) as unknown as SceneObject;
      setLocation(d, 3);
      select(face().onPlane("front"));
      const implicit = draft(4) as unknown as SceneObject;
      setLocation(implicit, 5);
      const scene = render();
      expect(errorsOf(scene)).toEqual([]);

      const handed = resolveFeatureSources(scene, boundaryOf(scene, 3));
      expect(handed).toMatchObject({ ok: true, feature: 'custom', id: 'draft' });
      const handedFaces = (handed as { slots: Record<string, unknown> }).slots.faces as { kind: string; entities: unknown[] }[];
      expect(handedFaces).toHaveLength(1);
      expect(handedFaces[0].kind).toBe('entities');
      expect(handedFaces[0].entities).toHaveLength(1);

      const taken = resolveFeatureSources(scene, boundaryOf(scene, 5));
      const takenFaces = (taken as { slots: Record<string, unknown> }).slots.faces as { kind: string; entities: unknown[] }[];
      expect(takenFaces).toHaveLength(1);
      expect(takenFaces[0]).toMatchObject({ kind: 'entities', entities: [{ sub: { type: 'face' } }] });
    });
  });
});
