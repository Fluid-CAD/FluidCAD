// Location values — connector, point and anchor pickers, and pickers of
// several kinds — end to end in the kernel: the metadata that declares them,
// the builder that reads them, the feature that stands at them, the slot
// synthesis that names a dialog's picks, the sources an edit seeds from,
// and the ghost that previews them.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import copy from "../../core/copy.js";
import select from "../../core/select.js";
import repeat from "../../core/repeat.js";
import { circle, point } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Primitives } from "../../sdk/kernel.js";
import { Matrix4 } from "../../math/matrix4.js";
import { ShapeProps } from "../../oc/props.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Connector } from "../../features/connector.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { FixedLocation, Locations } from "../../features/locations.js";
import { FeatureSlotSynthesizer } from "../../selection/feature-slots.js";
import { resolveFeatureSources, type SourceSlot } from "../../selection/feature-sources.js";
import { CustomFeatureGhost } from "../../rendering/custom-feature-ghost.js";
import { topologyVertices } from "../../selection/vertex-pick.js";
import type { PickRef, SelectionBoundary } from "../../selection/types.js";
import { Feature, defineFeature, parseCall, type FeatureMeta } from "../../sdk/index.js";
import { FeatureMetas, snapshotFeatureMeta } from "../../sdk/meta.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { faceRefsWhere, setLocation } from "../selection/pick-helpers.js";
import { boss, BOSS_DEFAULTS, defineBoss } from "../fixtures/custom-features/boss.js";
import type { ISceneObject } from "../../core/interfaces.js";

const PLATE = { w: 60, d: 40, t: 10 };
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.t;
const BOSS_VOLUME = Math.PI * ((BOSS_DEFAULTS.diameter / 2) ** 2 - (BOSS_DEFAULTS.hole / 2) ** 2) * BOSS_DEFAULTS.height;
const MESH = DEFAULT_MESH_CONFIG;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function solids(scene: Scene): Shape[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid());
}

function volumes(scene: Scene): number[] {
  return solids(scene).map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3).sort((a, b) => a - b);
}

/** Each solid's bounding box, rounded, sorted by its min x, y and z. */
function boxes(scene: Scene): number[][] {
  return solids(scene)
    .map(sh => ShapeOps.getExactBoundingBox(sh))
    .map(b => [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].map(v => Math.round(v * 1000) / 1000))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** A boss's box standing on `[x, y, z]`, growing along `axis` (`+z`, `+y`). */
function bossBox(x: number, y: number, z: number, axis: '+z' | '+y'): number[] {
  const r = BOSS_DEFAULTS.diameter / 2;
  const h = BOSS_DEFAULTS.height;
  return axis === '+z'
    ? [x - r, y - r, z, x + r, y + r, z + h]
    : [x - r, y, z - r, x + r, y + h, z + r];
}

type Plate = { plate: ExtrudeBase; top: Connector; marks: { geometries: { c: { center(): ISceneObject }; p: ISceneObject } } };

/**
 * Inside a part: a 60 × 40 × 10 plate centred on the origin, a connector at
 * the centre of its top, and a sketch on that top holding a circle centred
 * at (20, 10) and a point at (-20, -10). `then` runs in the part body.
 */
function plateIn(then: (made: Plate) => void): void {
  part("plate", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t) as unknown as ExtrudeBase;
    const top = connector("top", select(face().planar().onPlane("xy", PLATE.t))) as unknown as Connector;
    const marks = sketch(plate.endFaces(), () => ({ c: circle([20, 10], 4), p: point([-20, -10]) })) as unknown as Plate['marks'];
    then({ plate, top, marks });
  });
}

/** The plate's back face (y = 20: the xz plane faces -y, so -20 along it). */
const back = () => select(face().planar().onPlane("xz", -PLATE.d / 2)) as unknown as { center(): ISceneObject };

describe("location pickers: metadata", () => {
  setupOC();

  const meta = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    class Probe extends Feature {
      static id = "acme.probe";
      buildTool(): Shape[] {
        return [];
      }
    }
    return { class: Probe, label: "Probe", group: "create", kind: "tool", params, call: Object.keys(params), ...extra } as unknown as FeatureMeta;
  };

  it("takes a picker of several kinds, and snapshots it as they are listed", () => {
    const resolved = FeatureMetas.resolve(meta({ at: { picker: ["connector", "point", "anchor"], multiple: true, anchors: ["center"] } }));
    expect(FeatureMetas.kindsOf(resolved.params.at as never)).toEqual(["connector", "point", "anchor"]);
    expect(snapshotFeatureMeta(resolved).params.at).toEqual({
      picker: ["connector", "point", "anchor"], multiple: true, anchors: ["center"], label: "At",
    });
    // Copy targets: a solid or a connector.
    expect(() => FeatureMetas.resolve(meta({ targets: { picker: ["solid", "connector"], multiple: true } }))).not.toThrow();
    // An axis or a connector picks one thing.
    expect(() => FeatureMetas.resolve(meta({ around: { picker: ["axis", "connector"] } }))).not.toThrow();
  });

  it("refuses kinds that take the same click, and the fields no kind owns", () => {
    const refusal = (params: Record<string, unknown>) => {
      try {
        FeatureMetas.resolve(meta(params));
      } catch (error) {
        return (error as Error).message;
      }
      return null;
    };
    expect(refusal({ at: { picker: ["face", "anchor"] } })).toBe(
      "feature 'acme.probe': param 'at': both 'face' and 'anchor' take a face click — a picker of several kinds routes each click to the one kind that takes it; leave one out, or declare two values",
    );
    expect(refusal({ at: { picker: ["solid", "feature"], multiple: true } })).toContain("both 'solid' and 'feature' take a feature row click");
    expect(refusal({ at: { picker: ["edge", "face"], facesAsEdges: true } })).toContain("both 'edge' and 'face' take a face click");
    expect(refusal({ at: { picker: ["point"] } })).toBe(
      "feature 'acme.probe': param 'at': a picker that takes several kinds lists at least two, such as ['connector', 'point', 'anchor'] — for one, write picker: 'point'",
    );
    expect(refusal({ at: { picker: ["point", "pointy"] } })).toContain("unknown picker 'pointy'");
    expect(refusal({ at: { picker: ["point", "point"] } })).toContain(`'picker' lists "point" twice`);
    expect(refusal({ at: { picker: ["axis", "connector"], multiple: true } })).toBe(
      "feature 'acme.probe': param 'at': a picker that takes an axis picks one thing, so it takes no 'multiple'",
    );
    expect(refusal({ at: { picker: ["connector", "point"], curve: "line" } })).toContain(
      "unknown field 'curve' for a picker of connector or point",
    );
    expect(refusal({ at: { picker: ["sketch", "connector"], implicitDefault: true } })).toContain("leave 'implicitDefault' out");
  });
});

describe("location pickers: the builder and the feature", () => {
  setupOC();

  it("stands a boss at a connector, a sketch point and a face's centre in one statement", () => {
    plateIn(({ top, marks }) => {
      (boss([top, marks.geometries.c.center(), back().center()]) as unknown as Feature).new();
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(boxes(scene)).toEqual([
      [-30, -20, 0, 30, 20, 10],
      bossBox(0, 20, 5, '+y'),
      bossBox(0, 0, 10, '+z'),
      bossBox(20, 10, 10, '+z'),
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
    expect(volumes(scene).slice(0, 3).map(v => Math.round(v * 1000) / 1000))
      .toEqual([BOSS_VOLUME, BOSS_VOLUME, BOSS_VOLUME].map(v => Math.round(v * 1000) / 1000));
  });

  it("reads a point entity and a connector copy, fused into the plate", () => {
    plateIn(({ top, marks }) => {
      copy("linear", "x", { count: 2, offset: 15 }, top);
      boss([marks.geometries.p, top.instance(1)]);
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(volumes(scene)).toHaveLength(1);
    expect(volumes(scene)[0]).toBeCloseTo(PLATE_VOLUME + 2 * BOSS_VOLUME, 3);
  });

  it("stands at a point entity and a connector copy, each where it is", () => {
    plateIn(({ top, marks }) => {
      copy("linear", "x", { count: 2, offset: 15 }, top);
      (boss([marks.geometries.p, top.instance(1)]) as unknown as Feature).new();
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(boxes(scene)).toEqual([[-30, -20, 0, 30, 20, 10], bossBox(-20, -10, 10, '+z'), bossBox(15, 0, 10, '+z')]);
  });

  it("takes one location for a list of one, and the defaults ride on", () => {
    plateIn(({ top }) => {
      boss(top, { height: 12 });
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const box = ShapeOps.getExactBoundingBox(solids(scene)[0]);
    expect(box.maxZ).toBeCloseTo(22, 6);
  });

  it("refuses what is no location, naming the kinds it takes", () => {
    let refusal: string | null = null;
    plateIn(({ plate }) => {
      try {
        boss(plate as unknown as ISceneObject);
      } catch (error) {
        refusal = (error as Error).message;
      }
    });
    render();
    expect(refusal).toBe(
      "boss(): each of 'at' must be a connector (bolt, bolt.instance(2)), a point (s.geometries.c.center(), e.endEdges(0).start()) "
      + "or an anchor at center() (e.endFaces().center()), got an extrude",
    );
  });

  it("refuses an anchor at a point its picker doesn't offer, when no point is taken", () => {
    class Pin extends Feature.with({ at: { picker: "anchor", anchors: ["center"] } }) {
      static id = "acme.pin";
      buildTool(): Shape[] {
        return [];
      }
    }
    const pin = defineFeature(Pin, { label: "Pin", group: "create", call: ["at"] });
    let refusal: string | null = null;
    plateIn(({ plate }) => {
      try {
        pin(plate.endEdges(0).start() as unknown as ISceneObject);
      } catch (error) {
        refusal = (error as Error).message;
      }
    });
    render();
    expect(refusal).toBe("pin(): 'at' must be an anchor at center() (e.endFaces().center()), got an anchor at start()");
  });

  it("reads a frame only off a location", () => {
    class Lost extends Feature.with({ face: { picker: "face" } }) {
      static id = "acme.lost";
      buildTool(): Shape[] {
        this.frameOf(this.values.face);
        return [];
      }
    }
    const lost = defineFeature(Lost, { label: "Lost", group: "create", call: ["face"] });
    let made: SceneObject | null = null;
    plateIn(({ plate }) => {
      made = lost(plate.endFaces()) as unknown as SceneObject;
    });
    render();
    expect(made!.getError()).toBe("acme.lost: a select is not a location — declare the value as a connector, point or anchor picker");
  });

  it("moves its bosses with a repeat, reading the locations where they stand", () => {
    plateIn(({ top }) => {
      const b = (boss(top) as unknown as Feature).new();
      repeat("linear", "x", { count: 2, offset: 20 }, b);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const bosses = boxes(scene).filter(b => b[2] === 10);
    expect(bosses).toEqual([bossBox(0, 0, 10, '+z'), bossBox(20, 0, 10, '+z')]);
  });

  it("hits the cache across two definitions of its class", () => {
    const first = defineBoss();
    const second = defineBoss();
    expect(first.Boss).not.toBe(second.Boss);
    const plate = () => {
      sketch("xy", () => {
        testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
      });
      return extrude(PLATE.t) as unknown as ExtrudeBase;
    };
    const manager = getSceneManager();
    first.boss(plate().endFaces().center());
    render();
    const previous = manager.currentScene;

    const next = manager.startScene();
    const again = second.boss(plate().endFaces().center()) as unknown as SceneObject;
    SceneCompare.compare(previous, next);
    expect(next.isCached(again)).toBe(true);
    expect(errorsOf(render())).toEqual([]);

    const moved = manager.startScene();
    const elsewhere = second.boss(plate().startFaces().center()) as unknown as SceneObject;
    SceneCompare.compare(next, moved);
    expect(moved.isCached(elsewhere)).toBe(false);
  });

  it("knows each kind of location", () => {
    const frame = new Plane(new Point(1, 2, 3), new Vector3d(1, 0, 0), new Vector3d(0, 0, 1));
    const fixed = new FixedLocation(frame, 'anchor');
    expect(Locations.kindsOf(fixed)).toEqual(['anchor']);
    expect(Locations.accepts('connector', fixed)).toBe(true);
    expect(Locations.frameOf(fixed)).toBe(frame);
    expect(Locations.pointOf(fixed).toArray()).toEqual([1, 2, 3]);
    expect(Locations.kindsOf(42)).toEqual([]);
  });
});

/** The solid an object added. */
function solidOf(obj: SceneObject): Shape {
  const solid = obj.getAddedShapes().find(s => s.getType() === "solid");
  expect(solid).toBeDefined();
  return solid!;
}

/** The vertex index of `shape` nearest `[x, y, z]`. */
function vertexAt(shape: Shape, at: [number, number, number]): number {
  const coords = topologyVertices(shape);
  for (let i = 0; i * 3 < coords.length; i++) {
    if (Math.hypot(coords[i * 3] - at[0], coords[i * 3 + 1] - at[1], coords[i * 3 + 2] - at[2]) < 1e-6) {
      return i;
    }
  }
  throw new Error(`no vertex at ${at}`);
}

describe("location pickers: naming a dialog's picks", () => {
  setupOC();

  /** A 60 × 40 × 10 plate at the top level (line 2), a point sketch on its top (line 3, the point on line 4). */
  function platePoints() {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t) as unknown as ExtrudeBase;
    setLocation(plate, 2);
    let p: SceneObject | null = null;
    const marks = sketch(plate.endFaces(), () => {
      p = point([-20, -10]) as unknown as SceneObject;
      setLocation(p, 4);
    });
    setLocation(marks, 3);
    return { plate, point: () => p! };
  }

  it("writes a solid's vertex as the end of an edge, and a sketch's as a point the sketch exports", () => {
    const made = platePoints();
    const scene = render();
    const corner: PickRef = { shapeId: solidOf(made.plate as unknown as SceneObject).id, sub: { type: "vertex", index: vertexAt(solidOf(made.plate as unknown as SceneObject), [30, 20, 10]) } };
    const dot = made.point().getShapes()[0];
    const sketched: PickRef = { shapeId: dot.id, sub: { type: "vertex", index: 0 } };

    const result = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { at: { picker: "point", entities: [corner, sketched], options: { label: "At", multiple: true } } },
    });
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (!result.ok) {
      return;
    }
    const slot = result.slots.at;
    expect(slot.points).toHaveLength(2);
    expect(slot.points![0]).toMatchObject({ part: 0, suffix: expect.stringMatching(/^\.(start|end)\(\)$/) });
    expect(slot.args[0]).toMatch(/^e\..+\.(start|end)\(\)$/);
    const sketchPoint = slot.points![1] as { sketch: number; target: { line: number } };
    expect(result.producers[sketchPoint.sketch]).toMatchObject({ line: 3, featureType: "sketch", bind: true });
    expect(sketchPoint.target).toMatchObject({ line: 4 });
    expect(slot.args[1]).toBe("s.geometries.p1");
  });

  it("writes a face's centre as its own selector with the anchor after it", () => {
    const made = platePoints();
    const scene = render();
    const top = faceRefsWhere(solidOf(made.plate as unknown as SceneObject), mid => Math.abs(mid.z - PLATE.t) < 1e-6);
    expect(top).toHaveLength(1);

    const result = FeatureSlotSynthesizer.synthesize(scene, {
      slots: { at: { picker: "anchor", entities: top, anchors: [{ kind: "center" }], options: { label: "At", anchors: ["center"] } } },
    });
    expect(result).toMatchObject({
      ok: true,
      producers: [{ line: 2, featureType: "extrude", bind: true }],
      parts: [{ producer: 0, accessor: "endFaces" }],
      slots: { at: { parts: [0], points: [{ part: 0, suffix: ".center()" }], args: ["e.endFaces().center()"], wrap: null } },
    });
  });

  it("refuses picks a point or anchor value doesn't take", () => {
    const made = platePoints();
    const scene = render();
    const solid = solidOf(made.plate as unknown as SceneObject);
    const top = faceRefsWhere(solid, mid => Math.abs(mid.z - PLATE.t) < 1e-6);
    const corner: PickRef = { shapeId: solid.id, sub: { type: "vertex", index: 0 } };

    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { at: { picker: "point", entities: top, options: { label: "At" } } } }))
      .toMatchObject({ ok: false, reason: "At: takes points — a vertex of a solid or a sketch, not a face" });
    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { at: { picker: "anchor", entities: [corner], anchors: [{ kind: "center" }] } } }))
      .toMatchObject({ ok: false, reason: "at: takes anchors on faces and edges, not a vertex" });
    expect(FeatureSlotSynthesizer.synthesize(scene, {
      slots: { at: { picker: "anchor", entities: top, anchors: [{ kind: "start" }], options: { anchors: ["center"] } } },
    })).toMatchObject({ ok: false, reason: "at: takes anchors at center() — not start()" });
    expect(FeatureSlotSynthesizer.synthesize(scene, {
      slots: { at: { picker: "anchor", entities: top, anchors: [{ kind: "start" }] } },
    })).toMatchObject({ ok: false, reason: "at: start() needs an edge selection — a face only supports center()." });
    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { at: { picker: "anchor", entities: top } } }))
      .toMatchObject({ ok: false, reason: "at: each picked face or edge needs the anchor taken on it" });
    expect(FeatureSlotSynthesizer.synthesize(scene, { slots: { at: { picker: "point", entities: [corner, corner] } } }))
      .toMatchObject({ ok: false, reason: "at: pick exactly one point" });
  });
});

describe("location pickers: an edit's sources and the ghost", () => {
  setupOC();

  /** The edited boss's boundary: its timeline row, type and call site. */
  function boundaryOf(scene: Scene, feature: SceneObject): SelectionBoundary {
    const index = (scene.getTimelineObjects?.() ?? scene.getAllSceneObjects()).indexOf(feature);
    expect(index).toBeGreaterThanOrEqual(0);
    const loc = feature.getSourceLocation()!;
    return { index, type: feature.getType(), line: loc.line, column: loc.column };
  }

  it("seeds a connector by its statement, a copy and a point opaque, an anchor as its face", () => {
    let made: SceneObject | null = null;
    plateIn(({ top, marks }) => {
      setLocation(top, 3);
      copy("linear", "x", { count: 2, offset: 15 }, top);
      made = boss([top, top.instance(1), marks.geometries.c.center(), back().center()]) as unknown as SceneObject;
      setLocation(made, 9);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const sources = resolveFeatureSources(scene, boundaryOf(scene, made!));
    expect(sources.ok).toBe(true);
    if (!sources.ok || sources.feature !== "custom") {
      return;
    }
    const slots = sources.slots.at as SourceSlot[];
    expect(slots.map(slot => slot.kind)).toEqual(["sketch", "opaque", "opaque", "entities"]);
    expect(slots[0]).toMatchObject({ kind: "sketch", line: 3 });
    expect(slots[3].kind === "entities" && slots[3].entities.map(entity => entity.sub.type)).toEqual(["face"]);
  });

  it("draws a boss at a connector, an anchor and a solid's vertex — and an edit's kept locations where they built", () => {
    let made: SceneObject | null = null;
    plateIn(({ top, marks }) => {
      setLocation(top, 3);
      made = (boss([marks.geometries.c.center(), top]) as unknown as Feature).new();
      setLocation(made, 9);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const plateObj = scene.getAllSceneObjects().find(o => o.getType() === "extrude")!;
    const solid = plateObj.getShapes().find(s => s.isSolid()) ?? solidOf(plateObj);
    const top = Explorer.findFacesWrapped(solid).findIndex(f => f.getEdges().every(e => Math.abs(EdgeOps.getEdgeMidPoint(e).z - PLATE.t) < 1e-6));
    expect(top).toBeGreaterThanOrEqual(0);

    const ghost = (refs: Record<string, unknown[]>, exclude?: { filePath: string; line: number }) => CustomFeatureGhost.build(scene, {
      feature: "custom", builder: boss, values: {}, refs: refs as never, operation: "new", budgetMs: null, ...(exclude ? { exclude } : {}),
    }, MESH);

    const drawn = ghost({
      at: [
        { kind: "connector", filePath: "/ws/model.fluid.js", line: 3 },
        { kind: "anchor", entity: { shapeId: solid.id, index: top, kind: "face" }, anchor: { kind: "center" } },
      ],
    });
    expect(drawn.ok, drawn.ok === false ? drawn.reason : "").toBe(true);
    if (drawn.ok) {
      expect(drawn.solids).toHaveLength(2);
    }

    // A solid's corner stands as the end of the edge that names it.
    const corner = topologyVertices(solid).findIndex((_, i, all) => i % 3 === 0
      && Math.abs(all[i] - 30) < 1e-6 && Math.abs(all[i + 1] - 20) < 1e-6 && Math.abs(all[i + 2] - PLATE.t) < 1e-6) / 3;
    expect(corner).toBeGreaterThanOrEqual(0);
    const atCorner = ghost({ at: [{ kind: "point", shapeId: solid.id, index: corner }] });
    expect(atCorner.ok, atCorner.ok === false ? atCorner.reason : "").toBe(true);

    // The ghost freed what it built, and nothing the scene holds.
    expect(ShapeProps.getProperties(solid.getShape()).volumeMm3).toBeCloseTo(PLATE_VOLUME, 3);

    // A connector the scene doesn't hold, an anchor a face doesn't offer, a kind the value doesn't take.
    expect(ghost({ at: [{ kind: "connector", filePath: "/ws/model.fluid.js", line: 99 }] }))
      .toMatchObject({ ok: false, reason: "At: that pick is not in the rendered scene." });
    expect(ghost({ at: [{ kind: "anchor", entity: { shapeId: solid.id, index: top, kind: "face" }, anchor: { kind: "start" } }] }))
      .toMatchObject({ ok: false });
    expect(ghost({ at: [{ kind: "statement", filePath: "/ws/model.fluid.js", line: 3 }] })).toMatchObject({ ok: false });

    // Edit mode: the statement's own elements, read off its feature as it built.
    const kept = ghost({ at: [{ kind: "kept", index: 0 }, { kind: "kept", index: 1 }] }, { filePath: "/ws/model.fluid.js", line: 9 });
    expect(kept.ok, kept.ok === false ? kept.reason : "").toBe(true);
    if (kept.ok) {
      expect(kept.solids).toHaveLength(2);
    }
    expect(ghost({ at: [{ kind: "kept", index: 5 }] }, { filePath: "/ws/model.fluid.js", line: 9 })).toMatchObject({ ok: false });
    expect(ghost({ at: [{ kind: "kept", index: 0 }] })).toMatchObject({ ok: false });
  });

  it("stands an edit's kept elements in whatever they are: a solid by its shapes, a connector at its frame", () => {
    // A tag on each target: on a connector, at its frame; on a solid, on top of it.
    class Tag extends Feature.with({ targets: { picker: ["solid", "connector"], multiple: true } }) {
      static id = "acme.tag";
      buildTool(): Shape[] {
        return this.values.targets.map(target => {
          if (this.isLocation(target)) {
            const origin = this.frameOf(target).origin;
            return ShapeOps.transform(Primitives.makeCylinder(1, 2), Matrix4.fromTranslation(origin.x, origin.y, origin.z));
          }
          const box = ShapeOps.getExactBoundingBox(this.shapesOf(target)[0]);
          return ShapeOps.transform(Primitives.makeCylinder(1, 2), Matrix4.fromTranslation((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, box.maxZ));
        });
      }
    }
    const tag = defineFeature(Tag, { label: "Tag", group: "create", operations: ["new"], call: ["targets"] });
    let made: SceneObject | null = null;
    plateIn(({ plate, top }) => {
      made = tag([plate, top]) as unknown as SceneObject;
      setLocation(made, 9);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const kept = CustomFeatureGhost.build(scene, {
      feature: "custom", builder: tag, values: {}, refs: { targets: [{ kind: "kept", index: 0 }, { kind: "kept", index: 1 }] },
      operation: null, budgetMs: null, exclude: { filePath: "/ws/model.fluid.js", line: 9 },
    }, MESH);
    expect(kept.ok, kept.ok === false ? kept.reason : "").toBe(true);
    if (kept.ok) {
      expect(kept.solids).toHaveLength(2);
    }
  });

  it("draws a boss at a picked vertex, on its sketch's plane", () => {
    let dot: SceneObject | null = null;
    part("plate", () => {
      sketch("xy", () => {
        testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
      });
      const plate = extrude(PLATE.t) as unknown as ExtrudeBase;
      sketch(plate.endFaces(), () => {
        dot = point([-20, -10]) as unknown as SceneObject;
      });
    });
    const scene = render();
    const shape = dot!.getShapes()[0];
    const drawn = CustomFeatureGhost.build(scene, {
      feature: "custom", builder: boss, values: {}, refs: { at: [{ kind: "point", shapeId: shape.id, index: 0 }] }, operation: "new", budgetMs: null,
    }, MESH);
    expect(drawn.ok, drawn.ok === false ? drawn.reason : "").toBe(true);
    if (drawn.ok) {
      const zs = drawn.solids.flatMap(s => s.meshes).flatMap(m => Array.from({ length: m.vertices.length / 3 }, (_, i) => m.vertices[i * 3 + 2]));
      expect(Math.min(...zs)).toBeCloseTo(PLATE.t, 3);
      expect(Math.max(...zs)).toBeCloseTo(PLATE.t + BOSS_DEFAULTS.height, 3);
    }
  });
});

describe("location pickers: parseCall alone", () => {
  setupOC();

  it("reads a list of locations by the metadata", () => {
    const meta = defineBoss().meta;
    expect(() => parseCall(meta as unknown as FeatureMeta, [42])).toThrow("boss(): each of 'at' must be");
  });
});
