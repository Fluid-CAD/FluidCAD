// The standoff fixture, TypeScript copy: a PCB standoff — a cylinder boss
// with a bore through it — standing on a picked planar face. Written the way
// a project's standoff.feature.js is, against the SDK entry points only: the
// class declares its values with Feature.with() and defineFeature() makes its
// builder. defineStandoffWithMeta() builds the same standoff the Stage 2 way
// (a plain Feature subclass and registerBuilder with the whole metadata), so
// tests can hold the two paths to the same behaviour. The JavaScript copy is
// server/tests/fixtures/custom-features/standoff.feature.js; keep them in step.

import {
  Feature, defineFeature, parseCall, registerBuilder,
  type FeatureArgs, type FeatureBuckets, type FeatureMeta, type ValuesOf,
} from "../../../sdk/index.js";
import { getFeatureMeta, type ResolvedFeatureMeta } from "../../../index.js";
import { BooleanOps, Primitives, ShapeOps, type Face, type Shape } from "../../../sdk/kernel.js";
import { Matrix4, Plane } from "../../../math/index.js";

export const STANDOFF_DEFAULTS = { height: 10, outer: 6, hole: 3 };

/** The standoff's values, as `Feature.with()` declares them. */
const STANDOFF_PARAMS = {
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  height: { type: 'length', default: STANDOFF_DEFAULTS.height, min: 0 },
  outer: { type: 'length', default: STANDOFF_DEFAULTS.outer, min: 0, label: 'Boss diameter' },
  hole: { type: 'length', default: STANDOFF_DEFAULTS.hole, min: 0, label: 'Hole diameter' },
} as const;

/** `standoff(face, { height, outer, hole })`. */
const STANDOFF_CALL = ['face', { height: 'height', outer: 'outer', hole: 'hole' }] as const;

/** What the metadata says besides the class, its values and its call. */
const STANDOFF_META = {
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  icon: './standoff.svg',
  group: 'create',
  operations: ['add', 'new'],
} as const;

/** The values a standoff is constructed from: the face, then three lengths. */
export type StandoffValues = ValuesOf<typeof STANDOFF_PARAMS>;

export type StandoffFeature = Feature<StandoffValues>;

export type StandoffClass = new (values: StandoffValues) => StandoffFeature;

/** A standoff builder: its arguments typed from the call shape. */
export type StandoffFunction = (...args: FeatureArgs<typeof STANDOFF_PARAMS, typeof STANDOFF_CALL>) => StandoffFeature;

/** The options a standoff call takes after its face. */
export type StandoffOptions = NonNullable<Parameters<StandoffFunction>[1]>;

export type StandoffDefinition = { Standoff: StandoffClass; standoff: StandoffFunction; meta: ResolvedFeatureMeta };

/**
 * The tube a standoff adds, standing on `face` at its centre, and its
 * buckets: built on the XY plane, its faces classified there, then placed.
 */
function standoffTube(faces: Face[], { height, outer, hole }: StandoffValues): { tube: Shape; buckets: FeatureBuckets } {
  if (!(hole < outer)) {
    throw new Error(`standoff: the hole (${hole}) must be narrower than the boss (${outer})`);
  }
  if (faces.length !== 1) {
    throw new Error(`standoff: pick one planar face to stand on (got ${faces.length} faces)`);
  }
  const plane = faces[0].getPlane();
  const origin = plane.projectPoint(faces[0].center());

  const boss = Primitives.makeCylinder(outer / 2, height);
  const bore = Primitives.makeCylinder(hole / 2, height);
  const tube = BooleanOps.cutShapes(boss, bore);
  boss.dispose();
  bore.dispose();

  const tolerance = 1e-6 * Math.max(height, outer);
  const all = tube.getSubShapes('face');
  const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
  const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
  const walls = all.filter(f => !start.includes(f) && !end.includes(f));
  const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
  const internal = walls.filter(f => !side.includes(f));

  const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
  const placed = ShapeOps.transformTracking(tube, frame, all);
  tube.dispose();
  // Each group as the faces it became once placed.
  const [startFaces, endFaces, sideFaces, internalFaces] = [start, end, side, internal]
    .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));

  return {
    tube: placed.shape,
    buckets: { startFaces, endFaces, sideFaces, internalFaces, startPlane: new Plane(origin, plane.xDirection, plane.normal) },
  };
}

/**
 * The standoff class, its builder and its metadata, made anew on every call.
 * A workspace module is evaluated again on every render, so its feature
 * class is a new class each time; a test calls this twice to do the same.
 */
export function defineStandoff(): StandoffDefinition {
  class Standoff extends Feature.with(STANDOFF_PARAMS) {
    static id = 'acme.standoff';

    buildTool(): Shape[] {
      const { tube, buckets } = standoffTube(this.facesOf(this.values.face), this.values);
      this.setBuckets(buckets);
      return [tube];
    }
  }

  const standoff = defineFeature(Standoff, { ...STANDOFF_META, call: STANDOFF_CALL });
  return { Standoff, standoff, meta: getFeatureMeta(standoff)! };
}

/** The same standoff written the Stage 2 way: a plain `Feature` subclass, and `registerBuilder` with its whole metadata. */
export function defineStandoffWithMeta(): StandoffDefinition {
  class Standoff extends Feature<StandoffValues> {
    static id = 'acme.standoff';

    buildTool(): Shape[] {
      const { tube, buckets } = standoffTube(this.facesOf(this.values.face), this.values);
      this.setBuckets(buckets);
      return [tube];
    }
  }

  const meta: FeatureMeta = {
    ...STANDOFF_META,
    class: Standoff,
    kind: 'tool',
    params: STANDOFF_PARAMS,
    call: STANDOFF_CALL,
  };
  const standoff = registerBuilder(context =>
    (...args: unknown[]) => new Standoff(parseCall<StandoffValues>(meta, args)).addTo(context),
  { feature: meta }) as StandoffFunction;
  return { Standoff, standoff, meta: getFeatureMeta(standoff)! };
}

export const { Standoff, standoff } = defineStandoff();
