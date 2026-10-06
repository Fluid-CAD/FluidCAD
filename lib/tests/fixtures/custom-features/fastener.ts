// The fastener fixture, TypeScript copy: a screw clearance hole — a cylinder
// the screw's clearance wide, sunk into the material at a connector, a point
// or a face's centre, with a recess for the head: none (`plain`), the head's
// own height (`counterbore`), or the depth a 90° cone would reach
// (`countersink`; the SDK's primitives have no cone, so it is a flat recess).
// It is the fixture with choices: `size` is a select shown as a grid of
// images under Metric and Imperial headings, `head` a radio shown as cards.
// Written against the SDK entry points only. The JavaScript copy is
// server/tests/fixtures/custom-features/fastener.feature.js, with the images
// in fastener/ beside it; keep them in step.

import { Feature, defineFeature, type FeatureArgs, type ValuesOf } from "../../../sdk/index.js";
import { getFeatureMeta, type ResolvedFeatureMeta } from "../../../index.js";
import { BooleanOps, Primitives, ShapeOps, type Shape } from "../../../sdk/kernel.js";
import { Matrix4 } from "../../../math/index.js";

/** Each screw's clearance hole, head diameter and head height, in mm. */
export const FASTENER_SIZES = {
  m3: { clearance: 3.4, head: 6.5, headHeight: 3.0 },
  m4: { clearance: 4.5, head: 8.0, headHeight: 4.0 },
  m5: { clearance: 5.5, head: 10.0, headHeight: 5.0 },
  n4: { clearance: 3.3, head: 6.0, headHeight: 2.8 },
  n6: { clearance: 3.9, head: 7.5, headHeight: 3.5 },
} as const;

export const FASTENER_DEFAULTS = { size: 'm3', head: 'plain', depth: 10 } as const;

/** The fastener's values, as `Feature.with()` declares them. */
const FASTENER_PARAMS = {
  at: { picker: ['connector', 'point', 'anchor'], anchors: ['center'], label: 'At' },
  size: {
    type: 'select', label: 'Screw', default: 'm3', display: 'grid', columns: 3,
    options: [
      { label: 'M3', value: 'm3', image: './fastener/m3.svg', description: '3.4 mm clearance', group: 'Metric', keywords: ['iso'] },
      { label: 'M4', value: 'm4', image: './fastener/m4.svg', description: '4.5 mm clearance', group: 'Metric', keywords: ['iso'] },
      { label: 'M5', value: 'm5', image: './fastener/m5.svg', description: '5.5 mm clearance', group: 'Metric', keywords: ['iso'] },
      { label: '#4', value: 'n4', image: './fastener/n4.svg', description: '3.3 mm clearance', group: 'Imperial', keywords: ['unc', 'inch'] },
      { label: '#6', value: 'n6', image: './fastener/n6.svg', description: '3.9 mm clearance', group: 'Imperial', keywords: ['unc', 'inch'] },
    ],
  },
  head: {
    type: 'radio', display: 'cards', columns: 3,
    options: [
      { label: 'Plain', value: 'plain', image: './fastener/plain.svg', description: 'A through hole, nothing for the head' },
      { label: 'Counterbore', value: 'counterbore', image: './fastener/counterbore.svg', description: 'A flat recess the head sinks into' },
      { label: 'Countersink', value: 'countersink', image: './fastener/countersink.svg', description: 'A shallow recess for a flat head' },
    ],
  },
  depth: { type: 'length', default: FASTENER_DEFAULTS.depth, min: 0 },
} as const;

/** `fastener(at, { size, head, depth })`. */
const FASTENER_CALL = ['at', { size: 'size', head: 'head', depth: 'depth' }] as const;

export type FastenerValues = ValuesOf<typeof FASTENER_PARAMS>;

export type FastenerFeature = Feature<FastenerValues>;

export type FastenerFunction = (...args: FeatureArgs<typeof FASTENER_PARAMS, typeof FASTENER_CALL>) => FastenerFeature;

export type FastenerDefinition = { Fastener: new (values: FastenerValues) => FastenerFeature; fastener: FastenerFunction; meta: ResolvedFeatureMeta };

/**
 * The fastener class, its builder and its metadata, made anew on every call —
 * a workspace module is evaluated again on every render, so its class is a
 * new class each time.
 */
export function defineFastener(): FastenerDefinition {
  class Fastener extends Feature.with(FASTENER_PARAMS) {
    static id = 'acme.fastener';

    buildTool(): Shape[] {
      const tool = this.drilled();
      const frame = this.frameOf(this.values.at);
      const sunkIn = ShapeOps.transform(tool, Matrix4.fromTranslation(0, 0, -this.values.depth));
      const placed = ShapeOps.transform(sunkIn, Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin));
      tool.dispose();
      sunkIn.dispose();
      return [placed];
    }

    /** The hole standing on the XY plane: the screw's clearance wide, and its head's width over the head's depth at the top. */
    private drilled(): Shape {
      const { size, head, depth } = this.values;
      const screw = FASTENER_SIZES[size];
      const sunk = head === 'plain' ? 0 : head === 'counterbore' ? screw.headHeight : (screw.head - screw.clearance) / 2;
      if (!(depth > sunk)) {
        throw new Error(`fastener: the hole (${depth}) must be deeper than its ${head} (${sunk})`);
      }
      if (sunk === 0) {
        return Primitives.makeCylinder(screw.clearance / 2, depth);
      }
      const blank = Primitives.makeCylinder(screw.head / 2, depth);
      const outer = Primitives.makeCylinder(screw.head / 2, depth - sunk);
      const core = Primitives.makeCylinder(screw.clearance / 2, depth - sunk);
      const collar = BooleanOps.cutShapes(outer, core);
      const stepped = BooleanOps.cutShapes(blank, collar);
      for (const spent of [blank, outer, core, collar]) {
        spent.dispose();
      }
      return stepped;
    }
  }

  const fastener = defineFeature(Fastener, {
    label: 'Fastener hole',
    description: 'A screw clearance hole with a plain, counterbored or countersunk head',
    icon: './fastener.svg',
    group: 'create',
    operations: ['remove', 'new'],
    call: FASTENER_CALL,
  });
  return { Fastener, fastener, meta: getFeatureMeta(fastener)! };
}

export const { Fastener, fastener } = defineFastener();
