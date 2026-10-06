// The fastener fixture, JavaScript copy: a screw clearance hole — a cylinder
// the screw's clearance wide, sunk into the material at a connector, a point
// or a face's centre, with a recess for the head: none (`plain`), the head's
// own height (`counterbore`), or the depth a 90° cone would reach
// (`countersink`; the SDK's primitives have no cone, so it is a flat recess).
// It is the fixture with choices: `size` is a select shown as a grid of
// images under Metric and Imperial headings, `head` a radio shown as cards.
// This is the file a project keeps as `fastener.feature.js`, written against
// the public entry points only, with its images in fastener/ beside it. The
// TypeScript copy the lib tests build from is
// lib/tests/fixtures/custom-features/fastener.ts; keep the two in step.

import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

/** Each screw's clearance hole, head diameter and head height, in mm. */
const SIZES = {
  m3: { clearance: 3.4, head: 6.5, headHeight: 3.0 },
  m4: { clearance: 4.5, head: 8.0, headHeight: 4.0 },
  m5: { clearance: 5.5, head: 10.0, headHeight: 5.0 },
  n4: { clearance: 3.3, head: 6.0, headHeight: 2.8 },
  n6: { clearance: 3.9, head: 7.5, headHeight: 3.5 },
};

export class Fastener extends Feature.with({
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
  depth: { type: 'length', default: 10, min: 0 },
}) {
  static id = 'acme.fastener';

  buildTool() {
    const tool = this.drilled();
    const frame = this.frameOf(this.values.at);
    const sunkIn = ShapeOps.transform(tool, Matrix4.fromTranslation(0, 0, -this.values.depth));
    const placed = ShapeOps.transform(sunkIn, Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin));
    tool.dispose();
    sunkIn.dispose();
    return [placed];
  }

  /** The hole standing on the XY plane: the screw's clearance wide, and its head's width over the head's depth at the top. */
  drilled() {
    const { size, head, depth } = this.values;
    const screw = SIZES[size];
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

export const fastener = defineFeature(Fastener, {
  label: 'Fastener hole',
  description: 'A screw clearance hole with a plain, counterbored or countersunk head',
  icon: './fastener.svg',
  group: 'create',
  operations: ['remove', 'new'],
  call: ['at', { size: 'size', head: 'head', depth: 'depth' }],
});
