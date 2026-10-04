// The boss fixture, TypeScript copy: a bolt-pattern boss — a cylinder with a
// bore through it — standing at every location it is handed, whatever kind:
// a connector (`bolt`, `bolt.instance(2)`), a point (`s.geometries.c.center()`,
// `e.endEdges(0).start()`) or a face's centre (`e.endFaces().center()`). Each
// boss grows along its location's frame. Written against the SDK entry points
// only, with Feature.with() and defineFeature(). The JavaScript copy is
// server/tests/fixtures/custom-features/boss.feature.js; keep them in step.

import { Feature, defineFeature, type FeatureArgs, type FeatureBuckets, type ValuesOf } from "../../../sdk/index.js";
import { getFeatureMeta, type ResolvedFeatureMeta } from "../../../index.js";
import { BooleanOps, Primitives, ShapeOps, type Face, type Shape } from "../../../sdk/kernel.js";
import { Matrix4, type Plane } from "../../../math/index.js";

export const BOSS_DEFAULTS = { diameter: 8, height: 6, hole: 3 };

/** The boss's values, as `Feature.with()` declares them. */
const BOSS_PARAMS = {
  at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'], label: 'At' },
  diameter: { type: 'length', default: BOSS_DEFAULTS.diameter, min: 0, label: 'Boss diameter' },
  height: { type: 'length', default: BOSS_DEFAULTS.height, min: 0 },
  hole: { type: 'length', default: BOSS_DEFAULTS.hole, min: 0, label: 'Hole diameter' },
} as const;

/** `boss(at, { diameter, height, hole })` — one location, or a list of them. */
const BOSS_CALL = ['at', { diameter: 'diameter', height: 'height', hole: 'hole' }] as const;

export type BossValues = ValuesOf<typeof BOSS_PARAMS>;

export type BossFeature = Feature<BossValues>;

export type BossFunction = (...args: FeatureArgs<typeof BOSS_PARAMS, typeof BOSS_CALL>) => BossFeature;

export type BossDefinition = { Boss: new (values: BossValues) => BossFeature; boss: BossFunction; meta: ResolvedFeatureMeta };

/**
 * One boss standing on `frame`: built on the XY plane, its faces sorted
 * into buckets there, then placed on the frame — growing along its Z.
 */
function bossAt(frame: Plane, { diameter, height, hole }: BossValues): { boss: Shape; faces: Record<'start' | 'end' | 'side' | 'internal', Face[]> } {
  const cylinder = Primitives.makeCylinder(diameter / 2, height);
  let solid: Shape = cylinder;
  if (hole > 0) {
    const bore = Primitives.makeCylinder(hole / 2, height);
    solid = BooleanOps.cutShapes(cylinder, bore);
    cylinder.dispose();
    bore.dispose();
  }

  const tolerance = 1e-6 * Math.max(height, diameter);
  const all = solid.getSubShapes('face');
  const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
  const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
  const walls = all.filter(f => !start.includes(f) && !end.includes(f));
  const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
  const internal = walls.filter(f => !side.includes(f));

  const placement = Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin);
  const placed = ShapeOps.transformTracking(solid, placement, all);
  solid.dispose();
  const imagesOf = (group: Face[]) => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null);
  return {
    boss: placed.shape,
    faces: { start: imagesOf(start), end: imagesOf(end), side: imagesOf(side), internal: imagesOf(internal) },
  };
}

/**
 * The boss class, its builder and its metadata, made anew on every call — a
 * workspace module is evaluated again on every render, so its class is a new
 * class each time; a test calls this twice to do the same.
 */
export function defineBoss(): BossDefinition {
  class Boss extends Feature.with(BOSS_PARAMS) {
    static id = 'acme.boss';

    buildTool(): Shape[] {
      const { diameter, hole } = this.values;
      if (!(hole < diameter)) {
        throw new Error(`boss: the hole (${hole}) must be narrower than the boss (${diameter})`);
      }
      if (this.values.at.length === 0) {
        throw new Error('boss: pick where the bosses stand — a connector, a point or a face centre');
      }
      const frames = this.values.at.map(location => this.frameOf(location));
      const bosses = frames.map(frame => bossAt(frame, this.values));
      const buckets: FeatureBuckets = {
        startFaces: bosses.flatMap(b => b.faces.start),
        endFaces: bosses.flatMap(b => b.faces.end),
        sideFaces: bosses.flatMap(b => b.faces.side),
        internalFaces: bosses.flatMap(b => b.faces.internal),
        startPlane: frames[0],
      };
      this.setBuckets(buckets);
      return bosses.map(b => b.boss);
    }
  }

  const boss = defineFeature(Boss, {
    label: 'Boss',
    description: 'Bosses with a bore, standing at connectors, points and face centres',
    icon: './boss.svg',
    group: 'create',
    operations: ['add', 'new'],
    call: BOSS_CALL,
  });
  return { Boss, boss, meta: getFeatureMeta(boss)! };
}

export const { Boss, boss } = defineBoss();
