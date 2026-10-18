import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import axis from "../../core/axis.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { SceneObject } from "../../common/scene-object.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { buildFeatureGhost, type CustomGhostRequest, type FeatureGhostResult } from "../../rendering/feature-ghost.js";
import { getFeatureMeta, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { Feature, defineFeature, type FeatureBuildContext, type FeatureMeta } from "../../sdk/index.js";
import { Primitives, ShapeOps } from "../../sdk/kernel.js";
import { Matrix4 } from "../../math/index.js";
import { testRect } from "../helpers/profiles.js";
import { edgeRefsWhere, faceRefsWhere, setLocation } from "../selection/pick-helpers.js";
import { standoff, STANDOFF_DEFAULTS } from "../fixtures/custom-features/standoff.js";

const FILE = '/ws/model.fluid.js';

/** What the test features saw and built during their last ghost, for the disposal and read-back checks. */
const seen: {
  axis?: { origin: number[]; direction: number[] };
  operation?: string;
  built: Shape[];
  buckets: Shape[];
  held: Shape[];
} = { built: [], buckets: [], held: [] };

/** A cylinder of radius `r` and height `h` standing on z = `z`. */
function post(r: number, h: number, z: number): Shape {
  const cylinder = Primitives.makeCylinder(r, h);
  const placed = ShapeOps.transform(cylinder, Matrix4.fromTranslation(0, 0, z));
  cylinder.dispose();
  return placed;
}

/** `cap(body, { thickness })`: a Ø6 post on top of the picked solid. */
class Cap extends Feature.with({
  body: { picker: 'solid' },
  thickness: { type: 'length', default: 2, min: 0 },
}) {
  static id = 'acme.cap';

  buildTool(): Shape[] {
    const solids = this.shapesOf(this.values.body).filter(s => s.isSolid());
    if (solids.length === 0) {
      throw new Error('cap: nothing to cap');
    }
    const top = Math.max(...solids.map(s => ShapeOps.getBoundingBox(s).maxZ));
    seen.operation = this.getOperationMode();
    const tool = post(3, this.values.thickness, top);
    seen.built = [tool];
    const faces = tool.getSubShapes('face');
    seen.buckets = faces;
    this.setBuckets({ sideFaces: faces });
    return [tool];
  }
}
const cap = defineFeature(Cap, { label: 'Cap', group: 'create', operations: ['add', 'new', 'remove'], call: ['body', { thickness: 'thickness' }] });

/** `spindle(around, { height })`: records the axis it was handed. */
class Spindle extends Feature.with({
  around: { picker: 'axis' },
  height: { type: 'length', default: 5 },
}) {
  static id = 'acme.spindle';

  buildTool(): Shape[] {
    const a = this.axisOf(this.values.around);
    seen.axis = { origin: [a.origin.x, a.origin.y, a.origin.z], direction: [a.direction.x, a.direction.y, a.direction.z] };
    return [post(1, this.values.height, 0)];
  }
}
const spindle = defineFeature(Spindle, { label: 'Spindle', group: 'create', call: ['around', { height: 'height' }] });

/**
 * A tool that hands back a solid of the scene itself — as it is, or as a
 * copy sharing its handle — which the preview must never free.
 */
class Echo extends Feature.with({ body: { picker: 'solid' }, copy: { type: 'boolean', default: false } }) {
  static id = 'acme.echo';

  buildTool(): Shape[] {
    seen.held = this.shapesOf(this.values.body);
    seen.built = this.values.copy ? seen.held.map(s => s.copy()) : seen.held;
    return seen.built;
  }
}
const echo = defineFeature(Echo, { label: 'Echo', group: 'create', call: ['body', { copy: 'copy' }] });

/** A slow tool: it spins `wait` ms before building. */
class Slow extends Feature.with({ wait: { type: 'number', default: 40 } }) {
  static id = 'acme.slow';

  buildTool(): Shape[] {
    const until = performance.now() + this.values.wait;
    while (performance.now() < until) {
      // spin
    }
    return [post(1, 1, 0)];
  }
}
const slow = defineFeature(Slow, { label: 'Slow', group: 'create', call: [{ wait: 'wait' }] });

/** A modifier without a preview, and one that draws the faces it would change. */
class Taper extends Feature.with({ faces: { picker: 'face', multiple: true } }) {
  static id = 'acme.taper';
  override build(_ctx: FeatureBuildContext): void {}
}
const taper = defineFeature(Taper, { label: 'Taper', group: 'modify', call: ['...faces'] });

class Mark extends Feature.with({ faces: { picker: 'face', multiple: true } }) {
  static id = 'acme.mark';
  override build(_ctx: FeatureBuildContext): void {}
  override ghost(): Shape[] {
    return this.facesOf(this.values.faces).map(f => ShapeOps.transform(f, Matrix4.fromTranslation(0, 0, 1)));
  }
}
const mark = defineFeature(Mark, { label: 'Mark', group: 'modify', call: ['...faces'] });

/** A modifier whose preview is the outline of the faces it would change. */
class Trace extends Feature.with({ faces: { picker: 'face', multiple: true } }) {
  static id = 'acme.trace';
  override build(_ctx: FeatureBuildContext): void {}
  override ghost(): Shape[] {
    return this.edgesOf(this.values.faces).map(e => ShapeOps.transform(e, Matrix4.fromTranslation(0, 0, 1)));
  }
}
const trace = defineFeature(Trace, { label: 'Trace', group: 'modify', call: ['...faces'] });

/** A 60 × 40 × 10 plate centred on the origin (line 2), its top face at z = 10. */
function plate(): SceneObject {
  sketch('xy', () => {
    testRect(60, 40, { at: [-30, -20] });
  });
  const e = extrude(10) as unknown as SceneObject;
  setLocation(e, 2);
  return e;
}

/** The solid the object at `line` added — still there for a pick, whatever consumed it since. */
function solidAt(scene: Scene, line: number): Shape {
  const owner = scene.getAllSceneObjects().find(o => o.getSourceLocation()?.line === line && o.getAddedShapes().some(s => s.isSolid()));
  expect(owner).toBeDefined();
  return owner!.getAddedShapes().find(s => s.isSolid())!;
}

function topFaceOf(solid: Shape): { shapeId: string; index: number; kind: 'face' } {
  const [pick] = faceRefsWhere(solid, mid => Math.abs(mid.z - 10) < 1e-6);
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
    ...request,
  }, DEFAULT_MESH_CONFIG);
}

/** The z extent of every mesh a ghost answered with. */
function zRange(result: FeatureGhostResult): { min: number; max: number } {
  expect(result.ok).toBe(true);
  let min = Infinity;
  let max = -Infinity;
  for (const solid of (result as Extract<FeatureGhostResult, { ok: true }>).solids) {
    for (const mesh of solid.meshes) {
      const vertices = (mesh as { vertices: number[] }).vertices;
      for (let i = 2; i < vertices.length; i += 3) {
        min = Math.min(min, vertices[i]);
        max = Math.max(max, vertices[i]);
      }
    }
  }
  return { min, max };
}

function solidsOf(result: FeatureGhostResult) {
  expect(result.ok).toBe(true);
  return (result as Extract<FeatureGhostResult, { ok: true }>).solids;
}

describe("a custom feature's ghost", () => {
  setupOC();

  it("builds the standoff on a face picked in the viewport, its defaults filled", () => {
    plate();
    const scene = render();
    const face = topFaceOf(solidAt(scene, 2));

    const result = ghost(scene, standoff, { refs: { face: [{ kind: 'entities', entities: [face] }] } });
    expect(solidsOf(result)).toHaveLength(1);
    const range = zRange(result);
    expect(range.min).toBeCloseTo(10, 4);
    expect(range.max).toBeCloseTo(10 + STANDOFF_DEFAULTS.height, 4);

    const taller = zRange(ghost(scene, standoff, { values: { height: 4 }, refs: { face: [{ kind: 'entities', entities: [face] }] } }));
    expect(taller.max).toBeCloseTo(14, 4);
  });

  it("reads a picked statement by its call site, a named face selection included", () => {
    plate();
    const top = select(face().planar().onPlane('xy', 10));
    setLocation(top, 3);
    const scene = render();

    const result = ghost(scene, standoff, { refs: { face: [{ kind: 'statement', filePath: FILE, line: 3 }] } });
    expect(zRange(result).max).toBeCloseTo(10 + STANDOFF_DEFAULTS.height, 4);
  });

  it("reads a world axis, an axis statement and a picked straight edge as the axis they stand for", () => {
    plate();
    const a = axis('x');
    setLocation(a, 3);
    const scene = render();

    expect(ghost(scene, spindle, { refs: { around: [{ kind: 'standard', name: 'z' }] } }).ok).toBe(true);
    expect(seen.axis!.direction).toEqual([0, 0, 1]);

    expect(ghost(scene, spindle, { refs: { around: [{ kind: 'statement', filePath: FILE, line: 3 }] } }).ok).toBe(true);
    expect(seen.axis!.direction).toEqual([1, 0, 0]);

    const solid = solidAt(scene, 2);
    // A vertical edge of the plate, at its (30, 20) corner.
    const [corner] = edgeRefsWhere(solid, mid => Math.abs(mid.x - 30) < 1e-6 && Math.abs(mid.y - 20) < 1e-6);
    expect(corner).toBeDefined();
    const edge = { kind: 'entities' as const, entities: [{ shapeId: corner.shapeId, index: corner.sub.index, kind: 'edge' as const }] };
    expect(ghost(scene, spindle, { refs: { around: [edge] } }).ok).toBe(true);
    expect(seen.axis!.origin[0]).toBeCloseTo(30, 6);
    expect(seen.axis!.origin[1]).toBeCloseTo(20, 6);
    expect(Math.abs(seen.axis!.direction[2])).toBeCloseTo(1, 6);
  });

  it("constructs the feature with the operation the dialog shows", () => {
    const p = plate();
    void p;
    const scene = render();
    const body = { kind: 'statement' as const, filePath: FILE, line: 2 };

    expect(ghost(scene, cap, { refs: { body: [body] } }).ok).toBe(true);
    expect(seen.operation).toBe('add');
    expect(ghost(scene, cap, { refs: { body: [body] }, operation: 'remove' }).ok).toBe(true);
    expect(seen.operation).toBe('remove');
  });

  it("reads the scene as it stood before the edited statement", () => {
    const p = plate();
    const c = cap(p, { thickness: 3 }) as unknown as SceneObject;
    setLocation(c, 3);
    const scene = render();
    expect(c.getError()).toBeNull();
    const body = { kind: 'statement' as const, filePath: FILE, line: 2 };

    // The cap fused the plate away: read at the end of the scene, there is nothing left to cap.
    const atEnd = ghost(scene, cap, { refs: { body: [body] } });
    expect(atEnd).toEqual({ ok: false, reason: 'cap: nothing to cap' });

    // Edit mode unwinds the edited cap: the plate reads as it stood before it.
    const range = zRange(ghost(scene, cap, { values: { thickness: 5 }, refs: { body: [body] }, exclude: { filePath: FILE, line: 3 } }));
    expect(range.min).toBeCloseTo(10, 4);
    expect(range.max).toBeCloseTo(15, 4);
  });

  it("edits a standoff over the face it stood on, picked on the plate before it", () => {
    const p = plate();
    const s = standoff((p as unknown as { endFaces(): never }).endFaces()) as unknown as SceneObject;
    setLocation(s, 3);
    const scene = render();
    expect(s.getError()).toBeNull();
    const face = topFaceOf(solidAt(scene, 2));

    const range = zRange(ghost(scene, standoff, {
      values: { height: 20 },
      refs: { face: [{ kind: 'entities', entities: [face] }] },
      exclude: { filePath: FILE, line: 3 },
    }));
    expect(range.min).toBeCloseTo(10, 4);
    expect(range.max).toBeCloseTo(30, 4);
  });

  it("refuses what the scene no longer holds, and values its metadata refuses", () => {
    plate();
    const scene = render();
    const face = topFaceOf(solidAt(scene, 2));
    const refuse = (builder: Function, request: Parameters<typeof ghost>[2]) => {
      const result = ghost(scene, builder, request);
      expect(result.ok).toBe(false);
      return (result as { reason: string }).reason;
    };

    expect(refuse(standoff, { refs: { face: [{ kind: 'entities', entities: [{ ...face, shapeId: 'gone' }] }] } }))
      .toBe('On face: that pick is not in the rendered scene.');
    expect(refuse(standoff, { refs: { face: [{ kind: 'statement', filePath: FILE, line: 40 }] } }))
      .toBe('On face: that pick is not in the rendered scene.');
    expect(refuse(spindle, { refs: { around: [{ kind: 'standard', name: 'xy' }] } }))
      .toBe('Around: that pick is not in the rendered scene.');
    // A face is no axis.
    expect(refuse(spindle, { refs: { around: [{ kind: 'entities', entities: [face] }] } }))
      .toBe('Around: that pick is not in the rendered scene.');
    expect(refuse(standoff, { refs: { face: [{ kind: 'entities', entities: [face] }, { kind: 'entities', entities: [face] }] } }))
      .toBe('On face takes one pick, got 2.');
    expect(refuse(standoff, { values: { width: 3 }, refs: { face: [{ kind: 'entities', entities: [face] }] } }))
      .toBe("Standoff has no typed-in value 'width'.");
    expect(refuse(standoff, { values: { height: -1 }, refs: { face: [{ kind: 'entities', entities: [face] }] } }))
      .toBe("standoff(): 'height' must be at least 0, got -1");
    expect(refuse(standoff, {})).toBe("standoff(): 'face' is required");
    expect(refuse(standoff, { refs: { face: [{ kind: 'entities', entities: [face] }] }, exclude: { filePath: FILE, line: 40 } }))
      .toBe('That statement is not in the rendered scene.');
    expect(refuse(() => undefined, {})).toBe('That is not the builder of a feature.');
  });

  it("pauses instead of answering when the build outlasts its budget", () => {
    plate();
    const scene = render();

    const paused = ghost(scene, slow, { values: { wait: 40 }, budgetMs: 10 });
    expect(paused.ok).toBe(false);
    expect(paused).toMatchObject({ paused: true });
    expect((paused as { reason: string }).reason).toMatch(/^It took \d+\.\d s to build, over the 0\.0 s a preview may take\.$/);
    expect(paused).not.toHaveProperty('solids');

    expect(solidsOf(ghost(scene, slow, { values: { wait: 40 }, budgetMs: null }))).toHaveLength(1);
    expect(solidsOf(ghost(scene, slow, { values: { wait: 0 } }))).toHaveLength(1);
  });

  it("frees what it built, the buckets declared on the way, and never a shape the scene holds", () => {
    const p = plate();
    const scene = render();
    const plateSolid = p.getShapes().find(s => s.isSolid())!;

    expect(ghost(scene, cap, { refs: { body: [{ kind: 'statement', filePath: FILE, line: 2 }] } }).ok).toBe(true);
    expect(seen.built).toHaveLength(1);
    expect(seen.built[0].isReleased()).toBe(true);
    expect(seen.buckets.length).toBeGreaterThan(0);
    expect(seen.buckets.every(f => f.isReleased())).toBe(true);

    // The tool handed the plate's own solid back: it draws, and stays the scene's.
    expect(solidsOf(ghost(scene, echo, { refs: { body: [{ kind: 'statement', filePath: FILE, line: 2 }] } }))).toHaveLength(1);
    expect(seen.held).toEqual([plateSolid]);
    expect(plateSolid.isReleased()).toBe(false);

    // A copy sharing the solid's handle goes, the handle stays.
    expect(solidsOf(ghost(scene, echo, { values: { copy: true }, refs: { body: [{ kind: 'statement', filePath: FILE, line: 2 }] } }))).toHaveLength(1);
    expect(seen.built[0]).not.toBe(plateSolid);
    expect(seen.built[0].isReleased()).toBe(true);
    expect(ShapeOps.getBoundingBox(plateSolid).maxZ).toBeCloseTo(10, 6);

    // A cached face of a scene solid stays too, while the pick's own wrappers go.
    const cachedFaces = plateSolid.getSubShapes('face');
    expect(ghost(scene, mark, { refs: { faces: [{ kind: 'entities', entities: [topFaceOf(plateSolid)] }] } }).ok).toBe(true);
    expect(cachedFaces.every(f => !f.isReleased())).toBe(true);

    // The scene renders on as before.
    const again = render();
    expect(again.getAllSceneObjects().every(o => o.getError() === null)).toBe(true);
    expect(plateSolid.isReleased()).toBe(false);
  });

  it("draws a modifier only when its class overrides ghost(), and says whether in its metadata", () => {
    plate();
    const scene = render();
    const top = topFaceOf(solidAt(scene, 2));

    expect(getFeatureMeta(taper)!.ghost).toBe(false);
    expect(getFeatureMeta(mark)!.ghost).toBe(true);
    expect(getFeatureMeta(standoff)!.ghost).toBe(true);
    expect(snapshotFeatureMeta(getFeatureMeta(taper)!).ghost).toBe(false);
    expect(snapshotFeatureMeta(getFeatureMeta(mark)!).ghost).toBe(true);

    expect(ghost(scene, taper, { refs: { faces: [{ kind: 'entities', entities: [top] }] } }))
      .toEqual({ ok: false, reason: 'Taper draws no preview.' });
    const markedFace = ghost(scene, mark, { refs: { faces: [{ kind: 'entities', entities: [top] }] } });
    const marked = zRange(markedFace);
    expect(marked.min).toBeCloseTo(11, 4);
    expect(marked.max).toBeCloseTo(11, 4);
    // A face comes labelled as the overlay draws a body — unlabelled, it would draw nothing.
    const labels = solidsOf(markedFace)[0].meshes.map(mesh => (mesh as { label?: string }).label);
    expect(labels[0]).toBe('solid-faces');
    expect(labels.slice(1).length).toBeGreaterThan(0);
    expect(labels.slice(1).every(label => label === 'solid-edges')).toBe(true);
    // Edges come as outline alone.
    const traced = solidsOf(ghost(scene, trace, { refs: { faces: [{ kind: 'entities', entities: [top] }] } }));
    expect(traced).toHaveLength(4);
    expect(traced.flatMap(body => body.meshes.map(mesh => (mesh as { label?: string }).label)).every(label => label === 'solid-edges')).toBe(true);
  });

  it("turns the preview off when the metadata says so, and refuses one a modifier can't draw", () => {
    plate();
    const scene = render();

    class Quiet extends Feature.with({ wait: { type: 'number', default: 0 } }) {
      static id = 'acme.quiet';
      buildTool(): Shape[] {
        return [post(1, 1, 0)];
      }
    }
    const quiet = defineFeature(Quiet, { label: 'Quiet', group: 'create', call: [{ wait: 'wait' }], ghost: false });
    expect(getFeatureMeta(quiet)!.ghost).toBe(false);
    expect(ghost(scene, quiet, {})).toEqual({ ok: false, reason: 'Quiet draws no preview.' });

    class Bare extends Feature {
      static id = 'acme.bare';
      override build(): void {}
    }
    const meta = {
      class: Bare, label: 'Bare', group: 'modify', kind: 'modifier', ghost: true,
      params: { faces: { picker: 'face', multiple: true } }, call: ['...faces'],
    } as unknown as FeatureMeta;
    expect(() => registerBuilder(() => () => undefined, { feature: meta }))
      .toThrow("feature 'acme.bare': 'ghost: true' needs a preview to draw — a modifier draws one only when its class overrides ghost(ctx); override it, or leave 'ghost' out");
    for (const mode of ['toggle', 'always']) {
      expect(() => registerBuilder(() => () => undefined, { feature: { ...meta, ghost: mode } as unknown as FeatureMeta }))
        .toThrow(`feature 'acme.bare': 'ghost: "${mode}"' needs a preview to draw — a modifier draws one only when its class overrides ghost(ctx); override it, or leave 'ghost' out`);
    }
  });
});
