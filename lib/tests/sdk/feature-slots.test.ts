import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle } from "../../core/2d/index.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { SceneObject } from "../../common/scene-object.js";
import { FeatureSlotSynthesizer, type FeatureSlotRequest } from "../../selection/feature-slots.js";
import { resolveFeatureSources } from "../../selection/feature-sources.js";
import type { SelectionBoundary } from "../../selection/types.js";
import { testRect } from "../helpers/profiles.js";
import { edgeRefsWhere, faceRefsWhere, setLocation } from "../selection/pick-helpers.js";
import { standoff } from "../fixtures/custom-features/standoff.js";
import { Feature, registerBuilder, type FeatureBuildContext } from "../../sdk/index.js";

/** The solid added by the scene object at `line`. */
function solidAt(scene: Scene, line: number): Shape {
  const owner = scene.getAllSceneObjects().find(o => o.getSourceLocation()?.line === line);
  expect(owner).toBeDefined();
  const solid = owner!.getAddedShapes().find(s => s.getType() === "solid");
  expect(solid).toBeDefined();
  return solid!;
}

/** A 40 × 40 × 10 plate centred on the origin (line 2), its top at z = 10. */
function plate(): SceneObject {
  sketch("xy", () => {
    testRect(40, 40, { at: [-20, -20] });
  });
  const e = extrude(10) as unknown as SceneObject;
  setLocation(e, 2);
  return e;
}

/** A Ø20 × 10 boss beside the plate (line 4), its wall a cylinder. */
function boss(): SceneObject {
  sketch("xy", () => {
    circle([60, 0], 20);
  });
  const e = extrude(10) as unknown as SceneObject;
  setLocation(e, 4);
  return e;
}

const top = (mid: { z: number }) => Math.abs(mid.z - 10) < 1e-6;

describe("custom feature picked values", () => {
  setupOC();

  it("names a picked face by its producer's bucket", () => {
    plate();
    const scene = render();
    const picks = faceRefsWhere(solidAt(scene, 2), top);
    expect(picks).toHaveLength(1);

    const result = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { face: { picker: "face", entities: picks, options: { surface: "planar", label: "On face" } } },
    });
    expect(result).toMatchObject({
      ok: true,
      filePath: "/ws/model.fluid.js",
      producers: [{ line: 2, featureType: "extrude", nameHint: "e", bind: true }],
      parts: [{ producer: 0, accessor: "endFaces", indices: null, filterArgs: null }],
      slots: { face: { parts: [0], args: ["e.endFaces()"], wrap: null } },
    });
  });

  it("refuses a face of another surface, naming the filter it fails", () => {
    boss();
    const scene = render();
    const wall = faceRefsWhere(solidAt(scene, 4), mid => mid.z > -1e-6 && mid.z < 10 + 1e-6)
      .filter(ref => !faceRefsWhere(solidAt(scene, 4), top).some(t => t.sub.index === ref.sub.index))
      .filter(ref => !faceRefsWhere(solidAt(scene, 4), mid => Math.abs(mid.z) < 1e-6).some(b => b.sub.index === ref.sub.index));
    expect(wall).toHaveLength(1);

    const refused = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { face: { picker: "face", entities: wall, options: { surface: "planar", label: "On face" } } },
    });
    expect(refused).toMatchObject({ ok: false, slot: "face", pick: wall[0] });
    expect(refused.ok === false && refused.reason).toBe(
      "On face: the picked face is not planar — this value takes faces that match face().planar()",
    );

    const cylinder = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { face: { picker: "face", entities: wall, options: { surface: "cylinder" } } },
    });
    expect(cylinder.ok).toBe(true);
  });

  it("refuses an edge of another curve, and takes one that matches", () => {
    plate();
    boss();
    const scene = render();
    const straight = edgeRefsWhere(solidAt(scene, 2), mid => top(mid) && Math.abs(mid.y + 20) < 1e-6);
    const round = edgeRefsWhere(solidAt(scene, 4), top);
    expect(straight).toHaveLength(1);
    expect(round.length).toBeGreaterThan(0);

    const refused = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rim: { picker: "edge", entities: straight, options: { curve: "circle" } } },
    });
    expect(refused.ok === false && refused.reason).toBe(
      "rim: the picked edge is not a circle — this value takes edges that match edge().circle()",
    );
    const taken = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rim: { picker: "edge", entities: [round[0]], options: { curve: "circle" } } },
    });
    expect(taken.ok).toBe(true);
  });

  it("refuses a sub-shape the picker does not take", () => {
    plate();
    const scene = render();
    const edge = edgeRefsWhere(solidAt(scene, 2), top)[0];
    const face = faceRefsWhere(solidAt(scene, 2), top)[0];

    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { face: { picker: "face", entities: [edge] } } }))
      .toMatchObject({ ok: false, reason: "face: takes faces, not an edge", pick: edge });
    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { axis: { picker: "axis", entities: [face] } } }))
      .toMatchObject({ ok: false, reason: "axis: takes an edge, not a face" });
    // A face stands for its edges only where the picker says so.
    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { rims: { picker: "edge", entities: [face] } } }).ok).toBe(false);
    expect(FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rims: { picker: "edge", entities: [face], options: { facesAsEdges: true } } },
    }).ok).toBe(true);
  });

  it("holds a single value to one pick, and a list to its max", () => {
    plate();
    const scene = render();
    const edges = edgeRefsWhere(solidAt(scene, 2), top);
    expect(edges).toHaveLength(4);

    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { rim: { picker: "edge", entities: edges } } }))
      .toMatchObject({ ok: false, reason: "rim: pick exactly one edge" });
    expect(FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rims: { picker: "edge", entities: edges, options: { max: 3 } } },
    })).toMatchObject({ ok: false, reason: "rims: takes at most 3 edges, got 4" });

    const list = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rims: { picker: "edge", entities: edges, options: { multiple: true } } },
    });
    expect(list).toMatchObject({ ok: true, slots: { rims: { args: ["e.endEdges()"] } } });
  });

  it("keeps an ordered list's picks in pick order, one element each", () => {
    plate();
    boss();
    const scene = render();
    const side = (x: number) => faceRefsWhere(solidAt(scene, 2), mid => Math.abs(mid.x - x) < 1e-6);
    const picks = [...side(-20), ...faceRefsWhere(solidAt(scene, 4), top), ...side(20)];
    expect(picks).toHaveLength(3);
    const slot = (ordered: boolean) => {
      const result = FeatureSlotSynthesizer.synthesize(scene, {
        slots: { faces: { picker: "face", entities: picks, options: { max: 3, ...(ordered ? { ordered } : {}) } } },
      });
      expect(result.ok).toBe(true);
      return (result as Extract<typeof result, { ok: true }>).slots.faces.args;
    };

    // Grouped by producer, the plate's two sides make one element.
    expect(slot(false)).toHaveLength(2);
    // Ordered, the boss's top stays second, between them.
    const args = slot(true);
    expect(args).toHaveLength(3);
    expect(args[1]).toMatch(/^e2\.endFaces\(\)$/);
    expect(args[0]).toMatch(/^e\./);
    expect(args[2]).toMatch(/^e\./);
    expect(args[0]).not.toBe(args[2]);
  });

  it("names an edge value's picks as picked — a tangent chain is no part of a custom feature's request", () => {
    plate();
    const scene = render();
    const edge = edgeRefsWhere(solidAt(scene, 2), mid => top(mid) && Math.abs(mid.y + 20) < 1e-6);
    const plain = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rims: { picker: "edge", entities: edge, options: { multiple: true } } },
    });
    expect(plain.ok).toBe(true);
    // One that still carries a chain, as fillet's "Select with tangents" sends it, names the same picks — never `.withTangents()`.
    const chained = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { rims: { picker: "edge", entities: edge, chains: [{ seed: edge[0], members: edge }], options: { multiple: true } } as never },
    });
    expect(chained).toEqual(plain);
    expect(JSON.stringify(chained)).not.toContain("withTangents");
  });

  it("wraps an axis edge in axis() and a plane face in plane()", () => {
    plate();
    const scene = render();
    const edge = edgeRefsWhere(solidAt(scene, 2), mid => top(mid) && Math.abs(mid.y + 20) < 1e-6);
    const face = faceRefsWhere(solidAt(scene, 2), top);

    const result = FeatureSlotSynthesizer.synthesize(scene, {
      slots: {
        axis: { picker: "axis", entities: edge },
        plane: { picker: "plane", entities: face },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok !== true) {
      return;
    }
    expect(result.slots.axis).toMatchObject({ wrap: "axis", parts: [0] });
    expect(result.slots.axis.args[0]).toMatch(/^axis\(e\.endEdges\(.*\)\)$/);
    expect(result.slots.plane).toEqual({ wrap: "plane", parts: [1], args: ["plane(e.endFaces())"] });
    // One statement feeds both slots, so it is bound once.
    expect(result.producers).toHaveLength(1);
    expect(result.imports).toEqual(expect.arrayContaining(["axis", "plane"]));
  });

  it("uses the names the editor will bind", () => {
    plate();
    const scene = render();
    const face = faceRefsWhere(solidAt(scene, 2), top);
    const result = FeatureSlotSynthesizer.synthesize(scene,
      { slots: { face: { picker: "face", entities: face } } },
      { namer: producers => producers.map(() => "base") });
    expect(result).toMatchObject({ ok: true, slots: { face: { args: ["base.endFaces()"] } } });
  });

  it("resolves an edit's picks against the world before the edited statement", () => {
    const p = plate() as unknown as { endFaces(): never };
    const s = standoff(p.endFaces());
    setLocation(s, 3);
    const scene = render();
    const before = boundaryOf(scene, "acme.standoff", 3);
    // The plate's own solid, as a rollback to just before the standoff shows it.
    const face = faceRefsWhere(solidAt(scene, 2), top);
    expect(face).toHaveLength(1);

    const request: FeatureSlotRequest = { slots: { face: { picker: "face", entities: face } } };
    expect(getSceneManager()!.synthesizeFeatureSlots(scene, request, {}, before))
      .toMatchObject({ ok: true, slots: { face: { args: ["e.endFaces()"] } } });
    expect(getSceneManager()!.synthesizeFeatureSlots(scene, request, {}, { ...before, line: 9 }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("no longer matches") });
  });
});

/** The boundary of the edited statement: its row, type and call site. */
function boundaryOf(scene: Scene, type: string, line: number): SelectionBoundary {
  const index = scene.getAllSceneObjects().findIndex(o => o.getType() === type && o.getSourceLocation()?.line === line);
  expect(index).toBeGreaterThanOrEqual(0);
  return { index, type, line, column: 0 };
}

describe("custom feature sources", () => {
  setupOC();

  it("seeds a picked face as entities on the solid the feature stood on", () => {
    const p = plate() as unknown as { endFaces(): never };
    const s = standoff(p.endFaces(), { height: 12 });
    setLocation(s, 3);
    const scene = render();
    const face = faceRefsWhere(solidAt(scene, 2), top);

    const sources = resolveFeatureSources(scene, boundaryOf(scene, "acme.standoff", 3));
    expect(sources).toEqual({
      ok: true,
      feature: "custom",
      id: "acme.standoff",
      slots: { face: { kind: "entities", entities: face } },
    });
  });

  it("seeds statements by call site, and a list one slot per element", () => {
    const a = plate();
    const b = boss();
    const merge = registerBuilder(context => (targets: unknown[], gap: number) =>
      new Merge({ targets: targets as SceneObject[], gap }).addTo(context));
    const m = merge([a, b], 2);
    setLocation(m, 6);
    const scene = render();

    const sources = resolveFeatureSources(scene, boundaryOf(scene, "acme.merge", 6));
    expect(sources).toEqual({
      ok: true,
      feature: "custom",
      id: "acme.merge",
      slots: {
        targets: [
          { kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 },
          { kind: "sketch", filePath: "/ws/model.fluid.js", line: 4, column: 0 },
        ],
      },
    });
  });
});

/** A modifier reading a list of solids; it changes nothing, which is all a sources test needs. */
class Merge extends Feature<{ targets: SceneObject[]; gap: number }> {
  static id = "acme.merge";

  override build(_ctx: FeatureBuildContext): void {
    this.setBuckets({});
  }
}
