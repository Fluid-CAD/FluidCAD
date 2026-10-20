// A feature that follows what it was picked at: `propertiesOf()` reads a
// reference's plain data, `framesOf()` every placement it stands at, and
// `derive()` fixes the feature's own values from them — in the build, where
// a value the statement passes too is ignored with a warning on the row,
// and in the dialog's ghost, which reports what was fixed.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import hole from "../../core/hole.js";
import connector from "../../core/connector.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import { point } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { buildFeatureGhost, type CustomGhostRequest, type FeatureGhostResult } from "../../rendering/feature-ghost.js";
import { Feature, defineFeature } from "../../sdk/index.js";
import { Primitives, ShapeOps, type Shape } from "../../sdk/kernel.js";
import { Matrix4, type Plane } from "../../math/index.js";
import { Locations } from "../../features/locations.js";
import { setLocation } from "../selection/pick-helpers.js";
import type { ISceneObject } from "../../core/interfaces.js";

const FILE = '/ws/model.fluid.js';

/** What the probe read during its last build or preview. */
const seen: { frames: Plane[]; properties: Record<string, unknown>; values: Record<string, unknown> } = { frames: [], properties: {}, values: {} };

/**
 * A probe standing at a connector or a hole: a peg at every placement,
 * its size fixed from a hole's, its head flat in a countersunk one.
 */
class Probe extends Feature.with({
  at: { picker: ['connector', 'feature'], types: ['hole'], label: 'At' },
  size: { type: 'select', default: 'M5', label: 'Size', options: [{ label: 'M5', value: 'M5' }, { label: 'M6', value: 'M6' }] },
  head: { type: 'radio', default: 'socket', label: 'Head', options: [{ label: 'Socket', value: 'socket' }, { label: 'Flat', value: 'flat' }] },
  length: { type: 'length', default: 10, label: 'Length' },
}) {
  static id = 'acme.probe';

  override derive() {
    const p = this.propertiesOf(this.values.at);
    seen.properties = p;
    if (p.type !== 'hole') {
      return null;
    }
    const style = p.style as { kind: string } | null;
    return { size: p.size as 'M5' | 'M6', ...(style?.kind === 'countersink' ? { head: 'flat' as const } : {}) };
  }

  buildTool(): Shape[] {
    const frames = this.framesOf(this.values.at);
    seen.frames = frames;
    seen.values = this.values;
    return frames.map(frame => {
      const peg = Primitives.makeCylinder(this.values.size === 'M6' ? 3 : 2.5, this.values.length);
      const placed = ShapeOps.transform(peg, Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin));
      peg.dispose();
      return placed;
    });
  }
}

const probe = defineFeature(Probe, {
  label: 'Probe', group: 'create', operations: ['new'], ghost: 'always',
  call: ['at', { size: 'size', head: 'head', length: 'length' }],
});

/** A probe whose derive() misbehaves one way: `fix` is what it returns. */
function misfit(id: string, fix: unknown) {
  class Misfit extends Feature.with({
    at: { picker: ['connector', 'feature'], label: 'At' },
    size: { type: 'select', default: 'M5', options: [{ label: 'M5', value: 'M5' }, { label: 'M6', value: 'M6' }] },
  }) {
    static id = id;
    override derive() {
      return fix as never;
    }
    buildTool(): Shape[] {
      return [Primitives.makeCylinder(2, 5)];
    }
  }
  return defineFeature(Misfit, { label: 'Misfit', group: 'create', operations: ['new'], call: ['at', { size: 'size' }] });
}

type Plate = { plate: SceneObject; top: SceneObject; marks: { geometries: { a: ISceneObject; b: ISceneObject } } };

/**
 * Inside a part (a connector lives in one): a 60 × 40 × 10 plate centred on
 * the origin, a connector at its top centre, two sketch points on the top
 * at x = ±15. `then` runs in the part body.
 */
function plateIn(then: (made: Plate) => void): void {
  part('plate', () => {
    sketch('xy', () => {
      testRect(60, 40, { at: [-30, -20] });
    });
    const plate = extrude(10) as unknown as SceneObject & { endFaces(): ISceneObject };
    const top = connector('top', select(face().planar().onPlane('xy', 10))) as unknown as SceneObject;
    const marks = sketch(plate.endFaces(), () => ({ a: point([15, 0]), b: point([-15, 0]) })) as unknown as Plate['marks'];
    then({ plate, top, marks });
  });
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function ghost(scene: Scene, builder: Function, request: Partial<Omit<CustomGhostRequest, 'feature' | 'builder'>>): FeatureGhostResult {
  return buildFeatureGhost(scene, { feature: 'custom', builder, values: {}, refs: {}, operation: null, ...request }, DEFAULT_MESH_CONFIG);
}

const origins = (frames: Plane[]) => frames.map(f => [f.origin.x, f.origin.y, f.origin.z].map(v => Math.round(v * 1e6) / 1e6)).sort((a, b) => a[0] - b[0]);

describe("following a reference: propertiesOf, framesOf and derive", () => {
  setupOC();

  it("reads a hole's plain data and stands at each of its placements, its size fixed from the hole's", () => {
    let p!: Feature;
    plateIn(({ marks }) => {
      const h = hole('M6', marks.geometries.a as never, marks.geometries.b as never).counterbore() as unknown as ISceneObject;
      p = probe(h) as unknown as Feature;
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(seen.properties).toMatchObject({ type: 'hole', size: 'M6', style: { kind: 'counterbore' }, depth: null });
    expect((seen.properties.dimensions as { diameter: number }).diameter).toBeCloseTo(6.6, 6);
    expect(seen.properties.frames).toHaveLength(2);
    expect(origins(seen.frames)).toEqual([[-15, 0, 10], [15, 0, 10]]);
    expect(seen.frames.every(f => f.normal.z > 0.999)).toBe(true);
    expect(seen.values).toMatchObject({ size: 'M6', head: 'socket', length: 10 });
    expect(p.getDerived()).toEqual({ size: 'M6' });
    expect(p.getWarnings()).toEqual([]);
    expect(p.serialize()).toMatchObject({ values: { size: 'M5', head: 'socket', length: 10 }, derived: { size: 'M6' } });
    expect(p.serialize()).not.toHaveProperty('warnings');
    // Its own properties show the fixed value, so a feature picked at the probe reads M6.
    expect(p.describe()).toEqual({ type: 'acme.probe', size: 'M6', head: 'socket', length: 10 });
    // Two pegs, one per placement.
    expect(p.getShapes().filter(s => s.isSolid())).toHaveLength(2);
  });

  it("ignores a value the statement passes for one derive() fixes, with a warning on the row", () => {
    let p!: Feature;
    plateIn(({ marks }) => {
      const h = hole('M6', marks.geometries.a as never).countersink() as unknown as ISceneObject;
      p = probe(h, { size: 'M5', head: 'socket' }) as unknown as Feature;
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(seen.values).toMatchObject({ size: 'M6', head: 'flat' });
    expect(p.getWarnings()).toEqual([
      `'size' is "M6", fixed by what the feature was picked at — the statement's "M5" is ignored`,
      `'head' is "flat", fixed by what the feature was picked at — the statement's "socket" is ignored`,
    ]);
    expect(p.serialize()).toMatchObject({ derived: { size: 'M6', head: 'flat' }, warnings: [expect.stringContaining("'size' is"), expect.stringContaining("'head' is")] });
  });

  it("fixes nothing at a connector: the statement's values stand, and the row carries no derived values", () => {
    let p!: Feature;
    let top!: SceneObject;
    plateIn(made => {
      top = made.top;
      p = probe(top as unknown as ISceneObject, { size: 'M5' }) as unknown as Feature;
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(seen.properties).toMatchObject({ type: 'connector', name: 'top' });
    expect(origins(seen.frames)).toEqual([[0, 0, 10]]);
    expect(p.getDerived()).toEqual({});
    expect(p.serialize()).not.toHaveProperty('derived');
    expect(Locations.framesOf([top, top])).toHaveLength(2);
  });

  it("refuses what derive() fixes wrongly: a value the declaration rejects, a name that is no value, a picked value, a list", () => {
    plateIn(({ top }) => {
      const at = top as unknown as ISceneObject;
      misfit('acme.misfit-value', { size: 'M99' })(at);
      misfit('acme.misfit-name', { bogus: 1 })(at);
      misfit('acme.misfit-picked', { at: 'M6' })(at);
      misfit('acme.misfit-list', { size: ['M6'] })(at);
      misfit('acme.misfit-shape', 'M6')(at);
    });
    const scene = render();

    expect(errorsOf(scene)).toEqual([
      expect.stringContaining(`'size' must be one of "M5", "M6", got 'M99'`),
      expect.stringContaining(`derive() fixes 'bogus', which is not a value of the feature`),
      expect.stringContaining(`derive() fixes 'at', a picked value — it fixes typed-in values only`),
      expect.stringContaining(`derive() fixes 'size' to a list — a fixed value is a number, a string or a boolean`),
      expect.stringContaining(`derive() returns the values it fixes by name`),
    ]);
  });

  it("refuses a value nothing stands at", () => {
    class Nowhere extends Feature.with({ on: { picker: 'solid', label: 'On' } }) {
      static id = 'acme.nowhere';
      buildTool(): Shape[] {
        this.framesOf(this.values.on);
        return [];
      }
    }
    const nowhere = defineFeature(Nowhere, { label: 'Nowhere', group: 'create', operations: ['new'], call: ['on'] });
    plateIn(({ plate }) => {
      nowhere(plate as unknown as ISceneObject);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([expect.stringContaining('a extrude stands nowhere — a connector, a point, an anchor, or a feature with placements such as a hole')]);
  });

  it("previews on a hole picked by its statement: the stand-in carries its properties and placements, and the ghost reports what was fixed", () => {
    plateIn(({ marks }) => {
      const h = hole('M6', marks.geometries.a as never, marks.geometries.b as never).countersink() as unknown as SceneObject;
      setLocation(h, 4);
    });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const result = ghost(scene, probe, { values: { size: 'M5' }, refs: { at: [{ kind: 'statement', filePath: FILE, line: 4 }] } });
    expect(result.ok).toBe(true);
    const ok = result as Extract<FeatureGhostResult, { ok: true }>;
    expect(ok.solids).toHaveLength(2);
    expect(ok.derived).toEqual({ size: 'M6', head: 'flat' });
    expect(origins(seen.frames)).toEqual([[-15, 0, 10], [15, 0, 10]]);
    expect(seen.properties).toMatchObject({ type: 'hole', size: 'M6', style: { kind: 'countersink' } });
  });

  it("previews at a connector: the stand-in carries the connector's properties, and the ghost reports nothing fixed", () => {
    plateIn(({ top }) => {
      setLocation(top, 3);
    });
    const scene = render();

    const result = ghost(scene, probe, { refs: { at: [{ kind: 'connector', filePath: FILE, line: 3 }] } });
    expect(result.ok).toBe(true);
    expect((result as Extract<FeatureGhostResult, { ok: true }>).derived).toBeUndefined();
    expect(seen.properties).toMatchObject({ type: 'connector', name: 'top' });
    expect(origins(seen.frames)).toEqual([[0, 0, 10]]);
  });
});
