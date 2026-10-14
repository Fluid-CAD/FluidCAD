// The fastener fixture, TypeScript copy: a screw clearance hole — a cylinder
// the screw's clearance wide, sunk into the material at a connector, a point
// or a face's centre, with a recess for the head: none (`plain`), the head's
// own height (`counterbore`), or the depth a 90° cone would reach
// (`countersink`; the SDK's primitives have no cone, so it is a flat recess).
// It is the fixture with choices: `standard` is a radio shown as buttons,
// `size` a select shown as a grid of images that offers the screws of the
// chosen standard only (each option's `when`), `head` a radio shown as cards.
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

export const FASTENER_DEFAULTS = { standard: 'iso', size: 'm3', head: 'plain', depth: 10 } as const;

/** The fastener's values, as `Feature.with()` declares them. */
const FASTENER_PARAMS = {
  at: {
    picker: ['connector', 'point', 'anchor'], anchors: ['center'], label: 'At',
    description: "Where the screw enters: a connector, a point or a face centre (e.endFaces().center()). The hole is sunk into the material from there, against the location's normal (a connector's Z axis, a face's outward normal), so put it on the surface the screw goes in from.",
  },
  standard: {
    type: 'radio', display: 'buttons',
    options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }],
    description: "'iso' (metric) or 'unc' (imperial): which screws the dialog offers for size. It narrows the choice only; the hole is cut from size.",
  },
  size: {
    type: 'select', label: 'Screw', default: 'm3', display: 'grid', columns: 3,
    options: [
      { label: 'M3', value: 'm3', image: './fastener/m3.svg', description: '3.4 mm clearance', when: { standard: 'iso' }, keywords: ['iso'] },
      { label: 'M4', value: 'm4', image: './fastener/m4.svg', description: '4.5 mm clearance', when: { standard: 'iso' }, keywords: ['iso'] },
      { label: 'M5', value: 'm5', image: './fastener/m5.svg', description: '5.5 mm clearance', when: { standard: 'iso' }, keywords: ['iso'] },
      { label: '#4', value: 'n4', image: './fastener/n4.svg', description: '3.3 mm clearance', when: { standard: 'unc' }, keywords: ['unc', 'inch'] },
      { label: '#6', value: 'n6', image: './fastener/n6.svg', description: '3.9 mm clearance', when: { standard: 'unc' }, keywords: ['unc', 'inch'] },
    ],
    description: "The screw: 'm3', 'm4', 'm5' (metric) or 'n4', 'n6' (#4, #6 imperial). It sets the clearance diameter (3.4, 4.5, 5.5, 3.3, 3.9 mm) and the size of the head recess.",
  },
  head: {
    type: 'radio', display: 'cards', columns: 3,
    options: [
      { label: 'Plain', value: 'plain', image: './fastener/plain.svg', description: 'A through hole, nothing for the head' },
      { label: 'Counterbore', value: 'counterbore', image: './fastener/counterbore.svg', description: 'A flat recess the head sinks into' },
      { label: 'Countersink', value: 'countersink', image: './fastener/countersink.svg', description: 'A shallow recess for a flat head' },
    ],
    description: "The recess for the screw head: 'plain' (none), 'counterbore' (as wide as the head, as deep as the head is tall) or 'countersink' (a shallow flat recess for a flat head; the SDK has no cone).",
  },
  depth: {
    type: 'length', default: FASTENER_DEFAULTS.depth, min: 1, max: 50, display: 'slider', suffix: 'mm', hint: 'Measured from the surface',
    description: 'The whole depth of the hole from the surface, recess included (1 to 50). Must be deeper than the head recess; deeper than the material cuts through.',
  },
  /** A note kept with the hole — a part number, a torque class. It cuts nothing. */
  marking: {
    type: 'text', optional: true, placeholder: 'A2-70', maxLength: 12, pattern: '[A-Za-z0-9-]*', hint: 'Letters, digits and dashes',
    description: "An optional note kept with the hole, such as a part number or a torque class ('A2-70'): letters, digits and dashes, at most 12. It cuts nothing.",
  },
  /** What is done to the hole's rim afterwards, at most two of them. It cuts nothing. */
  finishes: {
    type: 'select', multiple: true, label: 'Finishes', default: ['deburr'], max: 2,
    options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }],
    description: "What is done to the hole's rim afterwards: an array of at most two of 'deburr', 'chamfer' and 'polish'. Recorded with the hole; it cuts nothing.",
  },
} as const;

/** `fastener(at, { standard, size, head, depth, marking, finishes })`. */
const FASTENER_CALL = ['at', { standard: 'standard', size: 'size', head: 'head', depth: 'depth', marking: 'marking', finishes: 'finishes' }] as const;

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
    layout: [
      'at',
      'standard',
      'size',
      'head',
      { note: 'The recess is sized for the head of the screw.', visibleWhen: { head: ['counterbore', 'countersink'] } },
      'depth',
      { image: './fastener/depth.svg', alt: 'The depth, measured from the surface', height: 64 },
      { section: 'Finish', collapsed: true, items: [{ row: ['marking', 'finishes'] }] },
    ],
    aside: [{ image: './fastener/section.svg', alt: 'A section through the hole' }],
  });
  return { Fastener, fastener, meta: getFeatureMeta(fastener)! };
}

export const { Fastener, fastener } = defineFastener();
