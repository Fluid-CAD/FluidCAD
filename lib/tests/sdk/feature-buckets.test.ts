import { describe, it, expect } from "vitest";
import type { TopAbs_ShapeEnum } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import { edge, face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { CheckJs } from "../helpers/check-js.js";
import { faceRefsWhere, setLocation } from "../selection/pick-helpers.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Face } from "../../common/face.js";
import { getOC } from "../../oc/init.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { buildFeatureGhost, type CustomGhostRequest, type FeatureGhostResult } from "../../rendering/feature-ghost.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { ClassifiedBucketRemapper, ClassifiedBuckets } from "../../features/classified-buckets.js";
import { getFeatureMeta, registerBuilder, snapshotFeatureMeta, FeatureDocs } from "../../index.js";
import { Feature, defineFeature, type FeatureBuildContext, type FeatureMeta, type ISelection } from "../../sdk/index.js";
import { Primitives, ShapeOps } from "../../sdk/kernel.js";
import { Matrix4, Point } from "../../math/index.js";
import { defineGear, gear, GEAR_DEFAULTS, type GearFunction, type GearVariant } from "../fixtures/custom-features/gear.js";

/** A plate's top face sits at z = 10; the default gear stands 8 on it. */
const PLATE_TOP = 10;
const GEAR_TOP = PLATE_TOP + GEAR_DEFAULTS.thickness;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** A lazy accessor's shapes — built here the way a consuming statement would build it. */
function resolved(selection: ISelection): Shape[] {
  const lazy = selection as unknown as SceneObject;
  lazy.build();
  return lazy.getShapes();
}

/** An 80 × 80 × 10 plate whose top face is centred on (`cx`, `cy`), built on line 2. */
function plate(cx = 0, cy = 0): SceneObject {
  sketch("xy", () => {
    testRect(80, 80, { at: [cx - 40, cy - 40] });
  });
  const e = extrude(PLATE_TOP) as unknown as SceneObject;
  setLocation(e, 2);
  return e;
}

type GearObject = SceneObject & Record<string, (...args: unknown[]) => ISelection>;

/** A gear on the plate's top face; `as` builds it with another definition of the class. */
function plateWithGear(options: Parameters<GearFunction>[1] = {}, as: GearFunction = gear, cx = 0) {
  const p = plate(cx) as SceneObject & { endFaces(): ISelection };
  const g = as(p.endFaces(), options) as unknown as GearObject;
  setLocation(g, 3);
  return { plate: p, gear: g };
}

/** Whether every one of `members` is one of `shapes` or a face or an edge of one. */
function allIn(members: Shape[], shapes: Shape[]): boolean {
  const oc = getOC();
  const held = new oc.TopTools_IndexedMapOfShape();
  try {
    for (const shape of shapes) {
      oc.TopExp.MapShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum, held);
      oc.TopExp.MapShapes(shape.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, held);
    }
    return members.every(member => held.FindIndex(member.getShape()) > 0);
  } finally {
    held.delete();
  }
}

/** Whether `a` and `b` hold the same shapes (by `IsSame`), whatever their order. */
function sameShapes(a: Shape[], b: Shape[]): boolean {
  return a.length === b.length && allIn(a, b) && allIn(b, a);
}

function solidsOf(obj: SceneObject): Shape[] {
  return obj.getShapes().filter(s => s.isSolid());
}

/** A face's centre of mass. */
function centroid(f: Shape): Point {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(f.getShape(), props, false, false);
  const c = props.CentreOfMass();
  const point = new Point(c.X(), c.Y(), c.Z());
  c.delete();
  props.delete();
  return point;
}

function expectNear(actual: Point, expected: Point): void {
  expect(actual.distanceTo(expected)).toBeLessThan(1e-4);
}

/** The custom bucket stored at `bucket:<name>`, as the state holds it. */
function stored(obj: SceneObject, name: string): Shape[] {
  return obj.getState(`bucket:${name}`) as Shape[];
}

const CUSTOM = ['tipFaces', 'tipEdges', 'flankFaces', 'rootFaces', 'boreFaces', 'boreEdges'];

describe("declaring buckets", () => {
  setupOC();

  const P = { n: { type: 'number', default: 1 } } as const;

  it.each([
    ['a name without the ending, with the name it may have meant', { teeth: {} }, "Feature.with(): 'teeth' needs to end in Faces or Edges (teethFaces?)"],
    ['a misspelt ending', { tip_face: {} }, "Feature.with(): 'tip_face' needs to end in Faces or Edges (tipFaces?)"],
    ['an ending alone', { Faces: {} }, "Feature.with(): 'Faces' needs a name before Faces, such as tipFaces"],
    ['a name that is too long', { [`${'a'.repeat(44)}Faces`]: {} }, `Feature.with(): the bucket name '${'a'.repeat(44)}Faces' is longer than 48 characters`],
    ['a declaration that is not an object', { tipFaces: 'The tips' }, "Feature.with(): bucket 'tipFaces' is declared with an object — {} or { label } — got 'The tips'"],
    ['a kind, which the ending gives', { tipFaces: { kind: 'face' } }, "Feature.with(): bucket 'tipFaces': leave 'kind' out — the name's ending gives it: a …Faces bucket holds faces, an …Edges bucket edges"],
    ['an unknown field', { tipFaces: { note: 'x' } }, "Feature.with(): bucket 'tipFaces': unknown field 'note' — a bucket declares only its label"],
    ['a description, which the docs pages hold', { tipFaces: { description: 'The tips' } }, "Feature.with(): bucket 'tipFaces': leave 'description' out — describe what the feature's buckets hold in the package's docs/ pages"],
    ['an empty label', { tipFaces: { label: ' ' } }, "Feature.with(): bucket 'tipFaces': 'label' must be text that says something, got ' '"],
    ['a member every feature has', { getAddedFaces: {} }, "Feature.with(): 'getAddedFaces' is already a member of SceneObject — give the bucket another name"],
  ])("refuses %s", (_name, buckets, message) => {
    expect(() => Feature.with(P, { buckets: buckets as never })).toThrow(message);
  });

  it("refuses more than 32 buckets, buckets that aren't an object, and any option but buckets", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`part${i}Faces`, {}]));
    expect(() => Feature.with(P, { buckets: many })).toThrow("Feature.with(): declares 33 buckets — a feature declares at most 32");
    expect(() => Feature.with(P, { buckets: Object.fromEntries(Object.entries(many).slice(0, 32)) })).not.toThrow();
    expect(() => Feature.with(P, { buckets: [] as never })).toThrow("Feature.with(): 'buckets' must be an object of the feature's buckets by name");
    expect(() => Feature.with(P, { bucket: {} } as never)).toThrow("Feature.with(): unknown option 'bucket' — the options are: buckets");
    expect(() => Feature.with(P, 'buckets' as never)).toThrow("Feature.with(): the second argument holds the feature's options");
  });

  it("refuses a method the class writes over a declared bucket, where the class registers or is constructed", () => {
    class Shadow extends Feature.with(P, { buckets: { tipFaces: {} } }) {
      static id = 'acme.shadow';
      // @ts-expect-error TS2425 on purpose: the base declares tipFaces as its accessor, so the types refuse this method as the runtime does.
      tipFaces(): ISelection {
        return this.endFaces();
      }
      buildTool(): Shape[] {
        return [];
      }
    }
    const message = "feature 'acme.shadow': Shadow writes tipFaces() itself — the declared bucket makes that accessor; remove the method or rename the bucket";
    expect(() => new Shadow({ n: 1 })).toThrow(message);
    expect(() => defineFeature(Shadow, { label: 'Shadow', group: 'create', call: [{ n: 'n' }] })).toThrow(message);

    class Plain extends Feature<{ n: number }> {
      static id = 'acme.plain-shadow';
      static buckets = { padFaces: {} };
      padFaces(): ISelection {
        return this.endFaces();
      }
    }
    expect(() => new Plain({ n: 1 })).toThrow("feature 'acme.plain-shadow': Plain writes padFaces() itself");
  });

  it("makes one accessor per custom bucket, and none for a standard name declared to relabel it", () => {
    const Base = Feature.with(P, { buckets: { tipFaces: {}, tipEdges: {}, endFaces: { label: 'Top Face' } } });
    const own = Object.getOwnPropertyNames(Base.prototype);
    expect(own).toContain('tipFaces');
    expect(own).toContain('tipEdges');
    expect(own).not.toContain('endFaces');
    expect(Base.prototype.endFaces).toBe(Feature.prototype.endFaces);
    // Read like the built-in ones: a method, not an enumerable field.
    expect(Object.keys(Base.prototype)).toEqual([]);
    expect(Base.prototype.tipFaces.name).toBe('tipFaces');
    expect(Object.isFrozen(Base.buckets)).toBe(true);
  });

  it("relabels a standard bucket declared with a label, and only that one", () => {
    class Lid extends Feature.with(P, { buckets: { endFaces: { label: 'Top Face' }, startEdges: {} } }) {
      static id = 'acme.lid';
    }
    const lid = new Lid({ n: 1 });
    expect(lid.bucketDefs('face').find(d => d.accessor === 'endFaces')!.label).toBe('Top Face');
    expect(lid.bucketDefs('edge').find(d => d.accessor === 'startEdges')!.label).toBe('Start Edges');
    expect(lid.bucketDefs('face').find(d => d.accessor === 'startFaces')!.label).toBe('Start Faces');
  });

  it("gives two Feature.with() bases their own accessors, and Feature none", () => {
    const A = Feature.with(P, { buckets: { tipFaces: {} } });
    const B = Feature.with(P, { buckets: { rootFaces: {} } });
    expect(typeof A.prototype.tipFaces).toBe('function');
    expect('rootFaces' in A.prototype).toBe(false);
    expect(typeof B.prototype.rootFaces).toBe('function');
    expect('tipFaces' in B.prototype).toBe(false);
    expect('tipFaces' in Feature.prototype).toBe(false);
    expect('rootFaces' in Feature.prototype).toBe(false);
    // A base declaring none carries an empty declaration.
    expect(Feature.with(P).buckets).toEqual({});
  });

  it("gives a plain subclass declaring static buckets its accessors, constructed or registered", () => {
    class Constructed extends Feature<{ n: number }> {
      static id = 'acme.constructed';
      static buckets = { padFaces: {} };
    }
    expect('padFaces' in Constructed.prototype).toBe(false);
    const feature = new Constructed({ n: 1 }) as unknown as Record<string, unknown>;
    expect(typeof feature.padFaces).toBe('function');

    class Registered extends Feature<{ n: number }> {
      static id = 'acme.registered';
      static buckets = { padFaces: {}, padEdges: { label: 'Pad Rims' } };
      buildTool(): Shape[] {
        return [];
      }
    }
    const meta: FeatureMeta = { class: Registered, label: 'Registered', group: 'create', kind: 'tool', params: { n: { type: 'number', default: 1 } }, call: [{ n: 'n' }] };
    registerBuilder(context => (n: number) => new Registered({ n }).addTo(context), { feature: meta });
    expect(typeof (Registered.prototype as unknown as Record<string, unknown>).padEdges).toBe('function');

    class Broken extends Feature<{ n: number }> {
      static id = 'acme.broken';
      static buckets = { pad: {} };
    }
    expect(() => new Broken({ n: 1 })).toThrow("feature 'acme.broken': 'pad' needs to end in Faces or Edges (padFaces?)");
  });

  it("is refused in a feature's metadata, by name", () => {
    class Post extends Feature.with(P) {
      static id = 'acme.post';
      buildTool(): Shape[] {
        return [];
      }
    }
    expect(() => defineFeature(Post, { label: 'Post', group: 'create', call: [{ n: 'n' }], buckets: { tipFaces: {} } } as never))
      .toThrow("defineFeature(Post): leave 'buckets' out — declare buckets on the class: Feature.with(params, { buckets })");
    const meta = { class: Post, label: 'Post', group: 'create', kind: 'tool', params: P, call: [{ n: 'n' }], buckets: {} };
    expect(() => registerBuilder(context => () => new Post({ n: 1 }).addTo(context), { feature: meta as never }))
      .toThrow("feature metadata: leave 'buckets' out — declare buckets on the class: Feature.with(params, { buckets }), or static buckets on a plain Feature subclass");
  });
});

describe("the gear's buckets", () => {
  setupOC();

  it("fills each custom bucket, carried across the fusion into the plate", () => {
    const { gear: g } = plateWithGear();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(g.getError()).toBeNull();

    const teeth = GEAR_DEFAULTS.teeth;
    expect(resolved(g.tipFaces())).toHaveLength(teeth);
    expect(resolved(g.flankFaces())).toHaveLength(2 * teeth);
    expect(resolved(g.rootFaces())).toHaveLength(teeth);
    expect(resolved(g.boreFaces())).toHaveLength(1);
    // The bore's rims, top and bottom (its seam is no model edge).
    expect(resolved(g.boreEdges())).toHaveLength(2);
    // Each tip land: its arc on top, its arc on the plate, and an edge down each flank.
    expect(resolved(g.tipEdges())).toHaveLength(4 * teeth);
    // The standard buckets beside them.
    expect(resolved(g.endFaces())).toHaveLength(1);
    expect(resolved(g.sideFaces())).toHaveLength(4 * teeth);
    expect(resolved(g.internalFaces())).toHaveLength(1);
  });

  it("derives a declared edge bucket from its face sibling, deduplicated", () => {
    const { gear: g } = plateWithGear();
    expect(errorsOf(render())).toEqual([]);

    const tips = resolved(g.tipFaces()) as Face[];
    const edges = resolved(g.tipEdges());
    expect(sameShapes(edges, ClassifiedBuckets.edgesOfFaces(tips))).toBe(true);
    expect(ClassifiedBucketRemapper.distinct(edges)).toHaveLength(edges.length);
  });

  it("reads indices and filters over a custom bucket", () => {
    const { gear: g } = plateWithGear();
    expect(errorsOf(render())).toEqual([]);

    const tips = resolved(g.tipFaces());
    const picked = resolved(g.tipFaces(0, 2));
    expect(picked).toHaveLength(2);
    expect(sameShapes(picked, [tips[0], tips[2]])).toBe(true);
    expect(resolved(g.flankFaces(face().planar()))).toHaveLength(2 * GEAR_DEFAULTS.teeth);
    expect(resolved(g.tipFaces(face().planar()))).toHaveLength(0);
    // The arcs atop the teeth.
    expect(resolved(g.tipEdges(edge().arc().onPlane('xy', GEAR_TOP)))).toHaveLength(GEAR_DEFAULTS.teeth);
  });

  it("makes no accessor for an edge bucket it doesn't declare", () => {
    const { gear: g } = plateWithGear();
    expect(errorsOf(render())).toEqual([]);
    expect((g as unknown as Record<string, unknown>).flankEdges).toBeUndefined();
    expect((g as unknown as Record<string, unknown>).rootEdges).toBeUndefined();
    expect(g.getState('bucket:flankEdges')).toBeUndefined();
  });

  it("is addressed through its custom buckets first, then the standard ones in their order", () => {
    const { gear: g } = plateWithGear();
    expect(errorsOf(render())).toEqual([]);

    expect(g.bucketDefs('face').map(d => d.accessor))
      .toEqual(['tipFaces', 'flankFaces', 'rootFaces', 'boreFaces', 'endFaces', 'startFaces', 'sideFaces', 'capFaces', 'internalFaces']);
    expect(g.bucketDefs('edge').map(d => d.accessor))
      .toEqual(['tipEdges', 'boreEdges', 'endEdges', 'startEdges', 'sideEdges', 'capEdges', 'internalEdges', 'edges']);
    expect(g.bucketDefs('edge').slice(0, 2)).toEqual([
      { key: 'bucket:tipEdges', accessor: 'tipEdges', kind: 'edge', label: 'Tip Edges', deriveFromFaceKey: 'bucket:tipFaces' },
      { key: 'bucket:boreEdges', accessor: 'boreEdges', kind: 'edge', label: 'Bore Rims', deriveFromFaceKey: 'bucket:boreFaces' },
    ]);
    expect(g.bucketDefs('face').find(d => d.accessor === 'endFaces')!.label).toBe('End Faces');
  });

  it("is indexed: a tip edge is found in the custom bucket before the standard ones", () => {
    const { gear: g } = plateWithGear();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const [arc] = resolved(g.tipEdges(edge().arc().onPlane('xy', GEAR_TOP)));
    const index = new SelectionIndex(scene);
    try {
      const hits = index.findHits(index.keyOf(arc), 'edge');
      expect(hits[0].bucket.def.accessor).toBe('tipEdges');
      expect(hits.map(h => h.bucket.def.accessor)).toContain('endEdges');
    } finally {
      index.dispose();
    }
  });
});

describe("setBuckets() refusals", () => {
  setupOC();

  /** A face of a cylinder the gear never returns. */
  function foreignFace(): Face {
    return Primitives.makeCylinder(1, 1).getSubShapes('face')[0] as Face;
  }

  const CASES: [string, GearVariant['fill'], string][] = [
    ['an unknown name, with the name it may have meant', b => ({ ...b, tipFace: b.tipFaces }),
      "acme.gear: setBuckets() 'tipFace' is not a bucket of gear — did you mean tipFaces?"],
    ['a misspelt standard name', b => ({ ...b, endFace: b.endFaces }),
      "acme.gear: setBuckets() 'endFace' is not a bucket of gear — did you mean endFaces?"],
    ['a value that is not a list', b => ({ ...b, tipFaces: b.tipFaces[0] }),
      'acme.gear: setBuckets() tipFaces must be a list of faces, got a face'],
    ['an edge in a face bucket', b => ({ ...b, tipFaces: [b.tipFaces[0].getEdges()[0]] }),
      'acme.gear: setBuckets() tipFaces[0] is an edge, not a face — tipFaces holds faces'],
    ['a face of a shape it does not return', b => ({ ...b, boreFaces: [...b.boreFaces, foreignFace()] }),
      'acme.gear: setBuckets() boreFaces[1] is not a face of the solids buildTool() returned — name faces of the shapes you return'],
  ];

  it.each(CASES)("refuses %s as the gear's build error, never a throw out of render()", (_name, fill, message) => {
    const { gear: g } = plateWithGear({}, defineGear({ fill }).gear);
    const scene = render();
    expect(g.getError()).toBe(message);
    expect(errorsOf(scene)).toHaveLength(1);
  });

  it.each(CASES)("refuses %s in the dialog's preview with the same message", (_name, fill, message) => {
    plate();
    const scene = render();
    const top = topFaceOf(scene);
    const result = ghost(scene, defineGear({ fill }).gear, { refs: { face: [{ kind: 'entities', entities: [top] }] } });
    expect(result).toEqual({ ok: false, reason: message });
  });

  it("refuses a startPlane that is not a plane, and buckets that are not named", () => {
    const { gear: g } = plateWithGear({}, defineGear({ fill: b => ({ ...b, startPlane: 'xy' }) }).gear);
    render();
    expect(g.getError()).toBe("acme.gear: setBuckets() startPlane must be a plane, got 'xy'");

    getSceneManager().startScene();
    const { gear: listed } = plateWithGear({}, defineGear({ fill: b => [b.tipFaces] as never }).gear);
    render();
    expect(listed.getError()).toBe('acme.gear: setBuckets() takes the buckets by name, such as { endFaces: [face] } — got a list');
  });

  it("lists the feature's buckets when no name is close", () => {
    const { gear: g } = plateWithGear({}, defineGear({ fill: b => ({ ...b, teeth: b.tipFaces }) }).gear);
    render();
    expect(g.getError()).toBe("acme.gear: setBuckets() 'teeth' is not a bucket of gear — its buckets are the standard ones "
      + '(startFaces, endFaces, sideFaces, internalFaces, capFaces and their Edges), and its own: tipFaces, tipEdges, flankFaces, rootFaces, boreFaces, boreEdges; '
      + 'declare another with Feature.with(params, { buckets })');
  });
});

describe("custom buckets across a fusion", () => {
  setupOC();

  it("keeps only what the final solid carries: no stale member", () => {
    const { gear: g } = plateWithGear();
    expect(errorsOf(render())).toEqual([]);

    const solids = solidsOf(g);
    expect(solids).toHaveLength(1);
    for (const name of CUSTOM) {
      expect(stored(g, name).length, name).toBeGreaterThan(0);
      expect(allIn(stored(g, name), solids), name).toBe(true);
    }
  });

  it("drops a tooth tip the stock swallows, and keeps what is left of its flanks", () => {
    const p = plate();
    // A tall block over the tip of the tooth on +X, fused into the plate.
    sketch("xy", () => {
      testRect(9, 6, { at: [21, -3] });
    });
    extrude(25);
    const g = gear((p as unknown as { endFaces(): ISelection }).endFaces()) as unknown as GearObject;
    expect(errorsOf(render())).toEqual([]);

    const solids = solidsOf(g);
    const teeth = GEAR_DEFAULTS.teeth;
    expect(resolved(g.tipFaces())).toHaveLength(teeth - 1);
    expect(resolved(g.flankFaces())).toHaveLength(2 * teeth);
    expect(resolved(g.rootFaces())).toHaveLength(teeth);
    expect(resolved(g.tipEdges())).toHaveLength(4 * (teeth - 1));
    for (const name of CUSTOM) {
      expect(allIn(stored(g, name), solids), name).toBe(true);
    }
    // What is left of the flanks stands outside the block: none reaches into it.
    const inside = resolved(g.flankFaces()).filter(f => {
      const box = ShapeOps.getExactBoundingBox(f);
      return box.maxX > 21 + 1e-6 && box.minY < 3 - 1e-6 && box.maxY > -3 + 1e-6;
    });
    expect(inside).toEqual([]);
  });

  it("derives the tip edges from the faces as they ended up: they take in where each tip meets the plate", () => {
    const { gear: g } = plateWithGear();
    expect(errorsOf(render())).toEqual([]);

    const junction = resolved(g.tipEdges(edge().onPlane('xy', PLATE_TOP)));
    expect(junction).toHaveLength(GEAR_DEFAULTS.teeth);
    // The same edges the gear's start edges name: where it meets the plate.
    expect(allIn(junction, resolved(g.startEdges()))).toBe(true);
  });

  it("takes a downstream fillet and chamfer through a custom accessor", () => {
    const { gear: g } = plateWithGear();
    fillet(0.3, g.tipEdges(edge().convex()));
    fillet(0.5, g.boreEdges());
    expect(errorsOf(render())).toEqual([]);

    getSceneManager().startScene();
    const separate = plateWithGear().gear.new();
    fillet(0.3, (separate as unknown as GearObject).tipEdges());
    expect(errorsOf(render())).toEqual([]);
  });
});

describe("custom buckets under repeat", () => {
  setupOC();

  it("moves each copy's buckets with it: a circular repeat's copies name their own faces", () => {
    const { gear: g } = plateWithGear({}, gear, 40);
    g.new();
    const r = repeat("circular", "z", { count: 3, angle: 360 }, g) as unknown as { instance(k: number): { getRoots(): SceneObject[] } };
    expect(errorsOf(render())).toEqual([]);

    const original = resolved(g.tipFaces());
    for (const k of [1, 2]) {
      const copy = r.instance(k).getRoots()[0] as GearObject;
      expect(copy).not.toBe(g);
      const moved = resolved(copy.tipFaces());
      expect(moved).toHaveLength(GEAR_DEFAULTS.teeth);
      expect(allIn(moved, solidsOf(copy))).toBe(true);
      expect(allIn(moved, solidsOf(g))).toBe(false);
      const transform = copy.getTransform()!;
      moved.forEach((f, i) => expectNear(centroid(f), centroid(original[i]).transform(transform)));
      expect(resolved(copy.boreEdges())).toHaveLength(2);
    }
  });

  it("keeps a mirrored copy's members in order, and an index picked on the original picks the mirrored member", () => {
    const { gear: g } = plateWithGear({}, gear, 40);
    g.new();
    const r = repeat("mirror", "yz", g) as unknown as { instance(k: number): { getRoots(): SceneObject[] } };
    expect(errorsOf(render())).toEqual([]);

    const copy = r.instance(1).getRoots()[0] as GearObject;
    const mirror = (p: Point) => new Point(-p.x, p.y, p.z);
    const original = resolved(g.tipFaces());
    resolved(copy.tipFaces()).forEach((f, i) => expectNear(centroid(f), mirror(centroid(original[i]))));
    // A statement's index pick, carried onto the copy as a repeated consumer carries it (atIndex on a mirrored copy).
    for (const i of [0, 3, 7]) {
      const carried = (g.tipFaces(i) as unknown as SceneObject).createCopy(new Map([[g as SceneObject, copy as SceneObject]]));
      carried.build();
      const [mirrored] = carried.getShapes();
      expectNear(centroid(mirrored), mirror(centroid(original[i])));
    }
    expect(allIn(resolved(copy.flankFaces()), solidsOf(copy))).toBe(true);
  });

  /**
   * Render `first`, then compare a scene authored by `second` against it:
   * whether the gear is cached. The second render reports no errors.
   */
  function cachedAcross(first: () => GearObject, second: () => GearObject): { cached: boolean; gear: GearObject } {
    const manager = getSceneManager();
    first();
    render();
    const previous = manager.currentScene;

    const next = manager.startScene();
    const feature = second();
    SceneCompare.compare(previous, next);
    const cached = next.isCached(feature);
    expect(errorsOf(render())).toEqual([]);
    return { cached, gear: feature };
  }

  it("keeps the buckets on a cache hit, the class defined again as a re-evaluated module defines it", () => {
    const { cached, gear: g } = cachedAcross(
      () => plateWithGear({}, defineGear().gear).gear,
      () => plateWithGear({}, defineGear().gear).gear,
    );
    expect(cached).toBe(true);
    expect(resolved(g.tipFaces())).toHaveLength(GEAR_DEFAULTS.teeth);
    expect(resolved(g.tipEdges())).toHaveLength(4 * GEAR_DEFAULTS.teeth);
    expect(allIn(stored(g, 'flankFaces'), solidsOf(g))).toBe(true);
  });

  it("rebuilds them when the teeth change", () => {
    const { cached, gear: g } = cachedAcross(
      () => plateWithGear().gear,
      () => plateWithGear({ teeth: 24 }).gear,
    );
    expect(cached).toBe(false);
    expect(resolved(g.tipFaces())).toHaveLength(24);
    expect(resolved(g.flankFaces())).toHaveLength(48);
  });
});

/**
 * A modifier: lifts the picked feature's solids, naming each lifted top face
 * a raised face — its rims derive from them.
 */
class Raise extends Feature.with({
  target: { picker: 'feature' },
  height: { type: 'length', default: 3 },
}, {
  buckets: {
    raisedFaces: {},
    raisedEdges: {},
  },
}) {
  static id = 'acme.raise';

  override build(_ctx: FeatureBuildContext): void {
    const target = this.values.target as unknown as SceneObject;
    const move = Matrix4.fromTranslation(0, 0, this.values.height);
    const lifted = target.getShapes(undefined, 'solid').map(solid => ShapeOps.transform(solid, move));
    target.removeShapes(this);
    this.addShapes(lifted);
    const top = Math.max(...lifted.map(solid => ShapeOps.getExactBoundingBox(solid).maxZ));
    this.setBuckets({
      raisedFaces: lifted.flatMap(solid => solid.getSubShapes('face'))
        .filter(f => Math.abs(ShapeOps.getExactBoundingBox(f).minZ - top) < 1e-6),
    });
  }
}

const raise = defineFeature(Raise, { label: 'Raise', group: 'modify', call: ['target', { height: 'height' }] });

describe("a modifier's custom buckets", () => {
  setupOC();

  it("names the final geometry at once, its declared edge bucket derived", () => {
    const box = plate();
    const r = raise(box, { height: 4 });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const [top] = resolved(r.raisedFaces());
    expect(ShapeOps.getExactBoundingBox(top).minZ).toBeCloseTo(PLATE_TOP + 4, 6);
    expect(resolved(r.raisedEdges())).toHaveLength(4);
    expect(allIn(stored(r, 'raisedFaces'), solidsOf(r))).toBe(true);
  });
});

describe("a custom feature's preview with custom buckets", () => {
  setupOC();

  it("frees the members of its custom buckets with the rest", () => {
    let members: Shape[] = [];
    // Only custom buckets: no standard one holds the members as well.
    const { gear: watched } = defineGear({
      fill: b => {
        members = [...b.tipFaces, ...b.flankFaces, ...b.rootFaces, ...b.boreFaces];
        return { tipFaces: b.tipFaces, flankFaces: b.flankFaces, rootFaces: b.rootFaces, boreFaces: b.boreFaces };
      },
    });
    const p = plate();
    const scene = render();
    const plateSolid = p.getShapes().find(s => s.isSolid())!;

    const result = ghost(scene, watched, { refs: { face: [{ kind: 'entities', entities: [topFaceOf(scene)] }] } });
    expect(result.ok).toBe(true);
    expect(members).toHaveLength(4 * GEAR_DEFAULTS.teeth + 1);
    expect(members.every(m => m.isReleased())).toBe(true);
    expect(plateSolid.isReleased()).toBe(false);
  });
});

describe("the metadata of a feature with buckets", () => {
  setupOC();

  it("leaves the buckets out of the snapshot and the doc gaps: the editor reads them off the class", () => {
    const meta = getFeatureMeta(gear)!;
    expect('buckets' in snapshotFeatureMeta(meta)).toBe(false);
    expect(FeatureDocs.missing(meta)).toEqual([]);
  });
});

describe("the types of a feature with buckets, in plain JavaScript", () => {
  const GEAR_MODULE = (fill: string) => `
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives } from 'fluidcad/sdk/kernel';

export class Gear extends Feature.with({
  face: { picker: 'face', surface: 'planar' },
  teeth: { type: 'integer', default: 20 },
}, {
  buckets: {
    tipFaces: {},
    tipEdges: {},
    endFaces: { label: 'Top Face' },
  },
}) {
  static id = 'acme.gear';

  buildTool() {
    const solid = Primitives.makeCylinder(10, this.values.teeth);
    const faces = solid.getSubShapes('face');
    this.setBuckets(${fill});
    return [solid];
  }
}

export const gear = defineFeature(Gear, { label: 'Gear', group: 'create', call: ['face', { teeth: 'teeth' }] });
`;

  const MODEL = `
import { extrude, fillet } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { gear } from './gear.feature.js';

const plate = extrude(5);
const g = gear(plate.endFaces());
fillet(0.3, g.tipEdges());
const flats = g.tipFaces(face().planar());
const two = g.tipFaces(0, 2);
const top = g.endFaces();
g.tipEdge();
`;

  function errorsOf(check: CheckJs): string[] {
    return check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`);
  }

  it("types each custom accessor on the feature, and setBuckets() over its names", () => {
    const check = CheckJs.check({ 'gear.feature.js': GEAR_MODULE('{ tipFaces: faces, endFaces: faces, tipEdges: [] }'), 'model.part.js': MODEL });
    expect(errorsOf(check)).toEqual([
      expect.stringMatching(/^model\.part\.js:12: Property 'tipEdge' does not exist on type .*Did you mean 'tipEdges'\?/),
    ]);
    expect(check.typeOf('model.part.js', 'flats')).toBe('ISelection');
    expect(check.typeOf('model.part.js', 'two')).toBe('ISelection');
  });

  it("makes a misspelt bucket an editor error, and a face in an edge bucket too", () => {
    const misspelt = CheckJs.check({ 'gear.feature.js': GEAR_MODULE('{ tipFace: faces }') });
    expect(errorsOf(misspelt)).toEqual([expect.stringMatching(/^gear\.feature\.js:20: Object literal may only specify known properties, .*'tipFace'/)]);
    const wrongKind = CheckJs.check({ 'gear.feature.js': GEAR_MODULE('{ tipEdges: faces }') });
    expect(errorsOf(wrongKind)).toEqual([expect.stringMatching(/^gear\.feature\.js:20: Type 'Face\[\]' is not assignable to type 'Edge\[\]'/)]);
  });
});

/** The plate's top face, picked in the viewport. */
function topFaceOf(scene: Scene): { shapeId: string; index: number; kind: 'face' } {
  const owner = scene.getAllSceneObjects().find(o => o.getSourceLocation()?.line === 2 && o.getAddedShapes().some(s => s.isSolid()));
  expect(owner).toBeDefined();
  const solid = owner!.getAddedShapes().find(s => s.isSolid())!;
  const [pick] = faceRefsWhere(solid, mid => Math.abs(mid.z - PLATE_TOP) < 1e-6);
  expect(pick).toBeDefined();
  return { shapeId: pick.shapeId, index: pick.sub.index, kind: 'face' };
}

function ghost(scene: Scene, builder: Function, request: Partial<Omit<CustomGhostRequest, 'feature' | 'builder'>>): FeatureGhostResult {
  return buildFeatureGhost(scene, {
    feature: 'custom',
    builder,
    values: {},
    refs: {},
    operation: null,
    budgetMs: null,
    ...request,
  }, DEFAULT_MESH_CONFIG);
}
