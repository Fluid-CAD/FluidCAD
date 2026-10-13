import { describe, it, expect, afterEach } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import { testRect } from "../helpers/profiles.js";
import { CheckJs } from "../helpers/check-js.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Point } from "../../math/index.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { attributePick } from "../../selection/attribution.js";
import { explainSelection, synthesizeApplyFeature } from "../../selection/explain.js";
import { expandBucket } from "../../selection/expand.js";
import { listSelectionGroups } from "../../selection/selection-groups.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionResult } from "../../selection/resolve-selection.js";
import type { PickRef, SynthesizeOptions } from "../../selection/types.js";
import { FeatureNamespaces } from "../../sdk/feature-namespaces.js";
import type { ISelection } from "../../sdk/index.js";
import { defineGear, gear, GEAR_DEFAULTS, type GearFunction } from "../fixtures/custom-features/gear.js";
import { pocket } from "../fixtures/custom-features/pocket.js";
import { edgeRefsWhere, faceRefsWhere, setLocation } from "./pick-helpers.js";

/** The plate's top face; the default gear stands 8 on it, its tips at radius 22 round the plate's centre. */
const PLATE_TOP = 10;
const GEAR_TOP = PLATE_TOP + GEAR_DEFAULTS.thickness;
const TIP_RADIUS = (GEAR_DEFAULTS.module * GEAR_DEFAULTS.teeth) / 2 + GEAR_DEFAULTS.module;

/** What the statements are called in the model the tests stand for, by line. */
const NAMES: Record<number, string> = { 2: 'plate', 3: 'g', 4: 'r', 5: 'p' };
const OPTIONS: SynthesizeOptions = { namer: producers => producers.map(p => NAMES[p.line] ?? null) };

type GearObject = SceneObject & Record<string, (...args: unknown[]) => ISelection>;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** An 80 × 80 × 10 plate centred on (`cx`, 0), built on line 2. */
function plate(cx = 0): SceneObject & { endFaces(): ISelection } {
  sketch("xy", () => {
    testRect(80, 80, { at: [cx - 40, -40] });
  });
  const e = extrude(PLATE_TOP).new() as unknown as SceneObject & { endFaces(): ISelection };
  setLocation(e, 2);
  return e;
}

/** A gear of its own (`.new()`) standing on a plate centred on (`cx`, 0), built on line 3. */
function standingGear(as: GearFunction = gear, cx = 0): GearObject {
  const p = plate(cx);
  const g = as(p.endFaces(), {}) as unknown as GearObject;
  (g as unknown as { new: () => unknown }).new();
  setLocation(g, 3);
  return g;
}

/** The features a repeat placed at slot `k`. */
function rootsAt(r: unknown, k: number): SceneObject[] {
  return (r as { instance(k: number): { getRoots(): SceneObject[] } }).instance(k).getRoots();
}

function solidOf(obj: SceneObject): Shape {
  const solid = obj.getAddedShapes().find(s => s.isSolid());
  expect(solid).toBeDefined();
  return solid!;
}

/** The solid's tip arcs round the top of the gear centred on (`cx`, 0). */
function topTipArcs(solid: Shape, cx = 0): PickRef[] {
  return edgeRefsWhere(solid, m => Math.abs(Math.hypot(m.x - cx, m.y) - TIP_RADIUS) < 1e-3 && Math.abs(m.z - GEAR_TOP) < 1e-6);
}

/** The solid's tooth tips: every edge on the tip circle. */
function tipFaces(solid: Shape, cx = 0): PickRef[] {
  return faceRefsWhere(solid, m => Math.abs(Math.hypot(m.x - cx, m.y) - TIP_RADIUS) < 1e-3);
}

/** A lazy accessor's shapes, built the way a consuming statement builds it. */
function resolved(selection: ISelection): Shape[] {
  const lazy = selection as unknown as SceneObject;
  lazy.build();
  return lazy.getShapes();
}

function resolveOk(scene: Scene, request: Parameters<typeof SelectionResolver.resolve>[1]): Extract<ResolveSelectionResult, { ok: true }> {
  const result = SelectionResolver.resolve(scene, request, {});
  expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
  return result as Extract<ResolveSelectionResult, { ok: true }>;
}

/**
 * Synthesizes the selector for `picks`, then runs it — and every alternative
 * — back through the real accessors (an instance's through its forwarders):
 * each must resolve to exactly the picks. The winning expression's source.
 */
function roundTrip(scene: Scene, picks: PickRef[]): string {
  const result = resolveOk(scene, { picks });
  const synthesized = result.synthesized!;
  expect(synthesized.ok, synthesized.ok === false ? synthesized.reason : '').toBe(true);
  const ok = synthesized as Extract<typeof synthesized, { ok: true }>;
  const key = (r: PickRef) => `${r.shapeId}/${r.sub.type}/${r.sub.index}`;
  for (const expression of [ok.expression, ...ok.alternatives.map(a => a.expression)]) {
    const back = resolveOk(scene, { expression }).matches.map(m => `${m.shapeId}/${m.kind}/${m.index}`).sort();
    expect(back, expression).toEqual(picks.map(key).sort());
  }
  return ok.source;
}

function synthesizeOk(scene: Scene, refs: PickRef[]) {
  const result = synthesizeApplyFeature(scene, refs, 'fillet', 1, [], OPTIONS);
  expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
  return result as Extract<typeof result, { ok: true }>;
}

function centre(shape: Shape): Point {
  const box = ShapeOps.getBoundingBox(shape);
  return new Point(box.centerX, box.centerY, box.centerZ);
}

describe("custom buckets in the editor", () => {
  setupOC();

  it("lists a pick's custom bucket before the standard ones, and attribution keeps that order on the creator", () => {
    const g = standingGear();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const [arc] = topTipArcs(solidOf(g));
    const [tip] = tipFaces(solidOf(g));

    const index = new SelectionIndex(scene);
    try {
      const arcKey = index.keyOf(Explorer.findEdgesWrapped(solidOf(g))[arc.sub.index]);
      expect(index.findHits(arcKey, 'edge').map(h => h.bucket.def.accessor)).toEqual(['tipEdges', 'endEdges']);
      expect(index.creatorOf(arcKey)).toBe(g);
      expect(attributePick(scene, index, arc).producer!.bucket.def.accessor).toBe('tipEdges');

      const tipKey = index.keyOf(Explorer.findFacesWrapped(solidOf(g))[tip.sub.index]);
      expect(index.findHits(tipKey, 'face').map(h => h.bucket.def.accessor)).toEqual(['tipFaces', 'sideFaces']);
      expect(attributePick(scene, index, tip).producer!.bucket.def.accessor).toBe('tipFaces');
    } finally {
      index.dispose();
    }
  });

  it("keeps the custom bucket first on a gear fused into the plate, where its creator preference sorts the hits", () => {
    const p = plate();
    const g = gear(p.endFaces(), {}) as unknown as GearObject;
    setLocation(g, 3);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const solid = solidOf(g);
    // The tip arcs where each tooth meets the plate: in the gear's tipEdges and its startEdges.
    const junction = edgeRefsWhere(solid, m => Math.abs(Math.hypot(m.x, m.y) - TIP_RADIUS) < 1e-3 && Math.abs(m.z - PLATE_TOP) < 1e-6);
    expect(junction).toHaveLength(GEAR_DEFAULTS.teeth);

    const index = new SelectionIndex(scene);
    try {
      const attr = attributePick(scene, index, junction[0]);
      expect(attr.producer!.bucket.feature).toBe(g);
      expect(attr.producer!.bucket.def.accessor).toBe('tipEdges');
    } finally {
      index.dispose();
    }
    expect(synthesizeOk(scene, [junction[0]]).spec.parts.map(part => part.accessor)).toEqual(['tipEdges']);
  });

  it("writes one tip edge as g.tipEdges(i), which resolves back to it", () => {
    const g = standingGear();
    const scene = render();
    const [arc] = topTipArcs(solidOf(g));

    // A constant-free filter that singles the edge out wins; the index form stays an alternative.
    const result = synthesizeOk(scene, [arc]);
    expect(result.spec.parts).toHaveLength(1);
    expect(result.spec.parts[0].accessor).toBe('tipEdges');
    expect(result.args).toMatch(/^g\.tipEdges\(.+\)$/);
    expect([result.args, ...result.alternatives]).toContainEqual(expect.stringMatching(/^g\.tipEdges\(\d+\)$/));
    expect(roundTrip(scene, [arc])).toMatch(/^f\.tipEdges\(/);
  });

  it("writes two tip faces through tipFaces — a filter or indices, never another bucket", () => {
    const g = standingGear();
    const scene = render();
    const tips = tipFaces(solidOf(g));
    expect(tips).toHaveLength(GEAR_DEFAULTS.teeth);
    const picks = [tips[0], tips[5]];

    const result = synthesizeOk(scene, picks);
    expect(result.spec.parts).toHaveLength(1);
    expect(result.spec.parts[0].accessor).toBe('tipFaces');
    expect(result.spec.parts[0].indices !== null || result.spec.parts[0].filterArgs !== null).toBe(true);
    expect(result.args).toMatch(/^g\.tipFaces\(.+\)$/);
    roundTrip(scene, picks);
  });

  it("writes every tip face as the whole bucket, g.tipFaces()", () => {
    const g = standingGear();
    const scene = render();

    const result = synthesizeOk(scene, tipFaces(solidOf(g)));
    expect(result.args).toBe('g.tipFaces()');
  });

  it("writes every side face of the gear as g.sideFaces(): the picks fill that bucket exactly", () => {
    const g = standingGear();
    const scene = render();
    // Flanks, tips and roots: every face clear of the bore.
    const sides = faceRefsWhere(solidOf(g), m => Math.hypot(m.x, m.y) > 10);
    expect(sides).toHaveLength(4 * GEAR_DEFAULTS.teeth);

    const result = synthesizeOk(scene, sides);
    expect(result.args).toBe('g.sideFaces()');
    expect(result.spec.parts).toHaveLength(1);
  });

  it("names a pick set that fills one bucket by it on a built-in too: a cut's every new edge is c.edges()", () => {
    sketch("xy", () => {
      testRect(60, 40, { at: [-30, -20] });
    });
    const base = extrude(10).new();
    setLocation(base, 2);
    sketch(base.endFaces(), () => {
      testRect(20, 10, { at: [-10, -5] });
    });
    const c = cut(4) as unknown as SceneObject;
    setLocation(c, 4);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    // The pocket's rim, its floor's rim and the creases between its walls.
    const solid = scene.getAllSceneObjects().flatMap(o => o.getShapes()).find(s => s.isSolid())!;
    const made = edgeRefsWhere(solid, m => Math.abs(m.x) <= 10 + 1e-6 && Math.abs(m.y) <= 5 + 1e-6 && m.z > 5);
    expect(made).toHaveLength(12);

    const result = synthesizeApplyFeature(scene, made, 'fillet', 1, [], { namer: () => ['c'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toBe('c.edges()');
    }
  });

  it("writes a pocket's floor as p.floorFaces(), and its whole rim as p.floorEdges() over the same endEdges", () => {
    const p = plate();
    const k = pocket(p.endFaces(), {}) as unknown as SceneObject;
    setLocation(k, 5);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const solid = solidOf(k);
    const floor = faceRefsWhere(solid, m => Math.abs(m.z - 5) < 1e-6);
    expect(floor).toHaveLength(1);
    expect(synthesizeOk(scene, floor).args).toBe('p.floorFaces()');

    const rim = edgeRefsWhere(solid, m => Math.abs(m.z - 5) < 1e-6 && Math.abs(m.x) < 20 && Math.abs(m.y) < 20);
    expect(rim).toHaveLength(8);
    const index = new SelectionIndex(scene);
    try {
      const key = index.keyOf(Explorer.findEdgesWrapped(solid)[rim[0].sub.index]);
      expect(index.findHits(key, 'edge').map(h => h.bucket.def.accessor)).toEqual(['floorEdges', 'endEdges', 'edges']);
    } finally {
      index.dispose();
    }
    expect(synthesizeOk(scene, rim).args).toBe('p.floorEdges()');
    const one = synthesizeOk(scene, [rim[0]]);
    expect(one.spec.parts[0].accessor).toBe('floorEdges');
    roundTrip(scene, [rim[0]]);
  });

  it("expands a double-clicked tip edge to the whole tipEdges bucket", () => {
    const g = standingGear();
    const scene = render();
    const [arc] = topTipArcs(solidOf(g));

    const result = expandBucket(scene, arc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accessor).toBe('tipEdges');
      expect(result.featureType).toBe('acme.gear');
      expect(result.members).toHaveLength(4 * GEAR_DEFAULTS.teeth);
      expect(result.members).toContainEqual(arc);
    }
  });

  it("offers Gear Tip Edges in the right-click menu, and the gear's other buckets as siblings", () => {
    const g = standingGear();
    const scene = render();
    const [arc] = topTipArcs(solidOf(g));
    const [tip] = tipFaces(solidOf(g));

    const edgeGroups = listSelectionGroups(scene, arc);
    expect(edgeGroups.ok).toBe(true);
    if (edgeGroups.ok) {
      const classified = edgeGroups.groups.find(group => group.kind === 'classified')!;
      expect(classified.label).toBe('Gear Tip Edges');
      expect(classified.members).toHaveLength(4 * GEAR_DEFAULTS.teeth);
      expect(edgeGroups.groups.filter(group => group.kind === 'sibling').map(group => group.label))
        .toEqual(['Gear Bore Rims', 'Gear End Edges', 'Gear Start Edges', 'Gear Side Edges', 'Gear Internal Edges']);
    }

    const faceGroups = listSelectionGroups(scene, tip);
    expect(faceGroups.ok).toBe(true);
    if (faceGroups.ok) {
      expect(faceGroups.groups.find(group => group.kind === 'classified')!.label).toBe('Gear Tip Faces');
      expect(faceGroups.groups.filter(group => group.kind === 'sibling').map(group => group.label)).toEqual([
        'Gear Flank Faces', 'Gear Root Faces', 'Gear Bore Faces',
        'Gear End Faces', 'Gear Start Faces', 'Gear Side Faces', 'Gear Internal Faces',
      ]);
    }
  });

  it("explains a tip edge pick as the tip edges of Gear", () => {
    const g = standingGear();
    const scene = render();
    const [arc] = topTipArcs(solidOf(g));

    const [pick] = explainSelection(scene, [arc]).picks;
    expect(pick.producer!.accessor).toBe('tipEdges');
    expect(pick.expression).toMatch(/^f\.tipEdges\(\d+\) — tip edges of Gear @ line 3$/);
  });

  describe("a feature from a package", () => {
    afterEach(() => {
      FeatureNamespaces.use(null);
    });

    it("reads Gear in the menus and the explanation, never its catalog key", () => {
      FeatureNamespaces.use(() => '@acme/feature-tests');
      const { gear: packaged } = defineGear();
      FeatureNamespaces.use(null);
      const g = standingGear(packaged);
      const scene = render();
      expect(errorsOf(scene)).toEqual([]);
      expect(g.getType()).toBe('@acme/feature-tests:acme.gear');
      const [arc] = topTipArcs(solidOf(g));

      const groups = listSelectionGroups(scene, arc);
      expect(groups.ok && groups.groups.find(group => group.kind === 'classified')!.label).toBe('Gear Tip Edges');
      expect(explainSelection(scene, [arc]).picks[0].expression).toContain('— tip edges of Gear @ line 3');
    });
  });
});

describe("custom buckets on a repeat's instances", () => {
  setupOC();

  it("writes a copy's tip edge as r.instance(2).tipEdges(i), evaluated through the instance's forwarder", () => {
    const g = standingGear(gear, 40);
    const r = repeat("circular", "z", { count: 3, angle: 360 }, g);
    setLocation(r, 4);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const copy = rootsAt(r, 2)[0];
    expect(copy.getCloneSource()).toBe(g);
    // The copy turned 240° about z: its centre sits at (40·cos 240°, 40·sin 240°).
    const solid = solidOf(copy);
    const c = centre(solid);
    const arcs = edgeRefsWhere(solid, m => Math.abs(Math.hypot(m.x - c.x, m.y - c.y) - TIP_RADIUS) < 1e-3 && Math.abs(m.z - GEAR_TOP) < 1e-6);
    expect(arcs).toHaveLength(GEAR_DEFAULTS.teeth);

    const result = synthesizeOk(scene, [arcs[3]]);
    expect(result.args).toMatch(/^r\.instance\(2\)\.tipEdges\(\d+\)$/);
    expect(roundTrip(scene, [arcs[3]])).toMatch(/^r\.instance\(2\)\.tipEdges\(/);

    // The forwarder is the instance's own, and reads the copy's bucket.
    const i = result.spec.parts[0].indices![0];
    const instance = r.instance(2) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(instance, 'tipEdges')).toBe(true);
    const [edge] = resolved((instance.tipEdges as (...args: unknown[]) => ISelection)(i));
    const picked = Explorer.findEdgesWrapped(solid)[arcs[3].sub.index];
    expect(edge.getShape().IsSame(picked.getShape())).toBe(true);
  });

  it("forwards every declared bucket on a copy of the instance too", () => {
    const g = standingGear();
    const r = repeat("linear", "x", { count: 2, offset: 100 }, g);
    render();
    const copy = (r.instance(1) as unknown as SceneObject).createCopy(new Map()) as unknown as Record<string, unknown>;
    for (const name of ['tipFaces', 'tipEdges', 'flankFaces', 'rootFaces', 'boreFaces', 'boreEdges']) {
      expect(typeof copy[name], name).toBe('function');
    }
    expect(resolved((copy.tipFaces as () => ISelection)())).toHaveLength(GEAR_DEFAULTS.teeth);
  });

  it("says the accessor is ambiguous when a slot holds two features, not that it is no function", () => {
    const a = standingGear();
    const p = plate(100);
    const b = gear(p.endFaces(), {}) as unknown as GearObject;
    (b as unknown as { new: () => unknown }).new();
    const r = repeat("linear", "y", { count: 2, offset: 100 }, a, b);
    render();
    const instance = r.instance(1) as unknown as Record<string, (...args: unknown[]) => unknown>;
    expect(() => instance.tipEdges()).toThrow(/clones 2 features per instance, so the accessor is ambiguous/);
  });

  it("names the mirror image of the original's member through a mirrored instance's custom accessor", () => {
    const g = standingGear(gear, 40);
    const m = repeat("mirror", "yz", g);
    setLocation(m, 4);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const mirror = (p: Point) => new Point(-p.x, p.y, p.z);

    for (const i of [0, 3, 7]) {
      const [original] = resolved(g.tipFaces(i));
      const [onCopy] = resolved((m.instance(1) as unknown as GearObject).tipFaces(i));
      expect(centre(onCopy).distanceTo(mirror(centre(original)))).toBeLessThan(1e-6);
    }

    // The editor's pick on the copy writes the index that names it there, and it resolves back.
    const copy = rootsAt(m, 1)[0];
    const arcs = edgeRefsWhere(solidOf(copy), mid => Math.abs(Math.hypot(mid.x + 40, mid.y) - TIP_RADIUS) < 1e-3 && Math.abs(mid.z - GEAR_TOP) < 1e-6);
    expect(arcs).toHaveLength(GEAR_DEFAULTS.teeth);
    for (const arc of [arcs[0], arcs[6]]) {
      expect(roundTrip(scene, [arc])).toMatch(/^m\.instance\(1\)\.tipEdges\(.+\)$/);
    }
  });
});

describe("the types of a repeated custom feature, in plain JavaScript", () => {
  const GEAR_MODULE = `
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives } from 'fluidcad/sdk/kernel';

export class Gear extends Feature.with({
  face: { picker: 'face', surface: 'planar' },
  teeth: { type: 'integer', default: 20 },
}, {
  buckets: {
    tipFaces: { description: 'The top land of every tooth' },
    tipEdges: { description: 'The edges round the tip faces' },
    endFaces: { description: 'The top of the gear' },
  },
}) {
  static id = 'acme.gear';

  buildTool() {
    const solid = Primitives.makeCylinder(10, this.values.teeth);
    this.setBuckets({ tipFaces: solid.getSubShapes('face') });
    return [solid];
  }
}

export const gear = defineFeature(Gear, { label: 'Gear', group: 'create', call: ['face', { teeth: 'teeth' }] });
`;

  const MODEL = `
import { extrude, fillet, repeat } from 'fluidcad/core';
import { edge } from 'fluidcad/filters';
import { gear } from './gear.feature.js';

const plate = extrude(5);
const g = gear(plate.endFaces());
const r = repeat('circular', 'z', { count: 3, angle: 360 }, g);
fillet(0.3, r.instance(1).tipEdges());
const convex = r.instance(2).tipEdges(edge().convex());
const top = r.instance(1).endEdges(0);
const m = repeat('mirror', 'yz', g);
const mirrored = m.instance(1).tipFaces(0);
const both = repeat('linear', 'x', { count: 2, offset: 40 }, plate, g);
both.instance(1).endEdges();
both.instance(1).tipEdges();
const plain = repeat('linear', 'x', { count: 2, offset: 40 }, plate);
plain.instance(1).tipEdges();
r.instance(1).tipEdge();
`;

  it("types each instance's forwarded custom accessors, for one repeated feature only", () => {
    const check = CheckJs.check({ 'gear.feature.js': GEAR_MODULE, 'model.part.js': MODEL });
    expect(check.diagnostics().map(d => `${d.file}:${d.line}: ${d.message}`)).toEqual([
      expect.stringMatching(/^model\.part\.js:16: Property 'tipEdges' does not exist on type /),
      expect.stringMatching(/^model\.part\.js:18: Property 'tipEdges' does not exist on type /),
      expect.stringMatching(/^model\.part\.js:19: Property 'tipEdge' does not exist on type .*Did you mean 'tipEdges'\?/),
    ]);
    expect(check.typeOf('model.part.js', 'convex')).toBe('ISelection');
    expect(check.typeOf('model.part.js', 'mirrored')).toBe('ISelection');
    expect(check.typeOf('model.part.js', 'top')).toBe('ISelection');
  });
});
