// @screenshot skip
// A clearance hole for a screw, sunk into the material at a connector, a point
// or the centre of a face, with a recess for the screw's head.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

/** Each screw's clearance hole, head diameter and head height, in mm. */
const SCREWS = {
  m3: { clearance: 3.4, head: 6.5, headHeight: 3 },
  m4: { clearance: 4.5, head: 8, headHeight: 4 },
  m5: { clearance: 5.5, head: 10, headHeight: 5 },
  n4: { clearance: 3.3, head: 6, headHeight: 2.8 },
  n6: { clearance: 3.9, head: 7.5, headHeight: 3.5 },
};

export class Fastener extends Feature.with({
  // A pick of three kinds: a connector, a sketch point or the centre of a face.
  at: { picker: ['connector', 'point', 'anchor'], anchors: ['center'], label: 'At' },
  // Two short choices, side by side as buttons.
  standard: {
    type: 'radio',
    display: 'buttons',
    options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }],
  },
  // Many choices told apart by their shape: a grid of pictures, searchable,
  // offering only the screws of the standard chosen above (`when`).
  size: {
    type: 'select',
    label: 'Screw',
    default: 'm3',
    display: 'grid',
    columns: 3,
    search: true,
    options: [
      { label: 'M3', value: 'm3', image: './fastener/m3.svg', description: '3.4 mm clearance', when: { standard: 'iso' } },
      { label: 'M4', value: 'm4', image: './fastener/m4.svg', description: '4.5 mm clearance', when: { standard: 'iso' } },
      { label: 'M5', value: 'm5', image: './fastener/m5.svg', description: '5.5 mm clearance', when: { standard: 'iso' } },
      { label: '#4', value: 'n4', image: './fastener/n4.svg', description: '3.3 mm clearance', when: { standard: 'unc' }, keywords: ['inch'] },
      { label: '#6', value: 'n6', image: './fastener/n6.svg', description: '3.9 mm clearance', when: { standard: 'unc' }, keywords: ['inch'] },
    ],
  },
  // A few choices, all worth seeing at once: picture cards.
  head: {
    type: 'radio',
    display: 'cards',
    columns: 2,
    options: [
      { label: 'Plain', value: 'plain', image: './fastener/plain.svg', description: 'Nothing for the head' },
      { label: 'Counterbore', value: 'counterbore', image: './fastener/counterbore.svg', description: 'A recess the head sinks into' },
    ],
  },
  depth: { type: 'length', default: 10, min: 1, max: 50, display: 'slider', suffix: 'mm', hint: 'Measured from the surface' },
}) {
  static id = 'fastener';

  buildTool() {
    const { size, head, depth } = this.values;
    const screw = SCREWS[size];
    const recess = head === 'counterbore' ? screw.headHeight : 0;
    if (!(depth > recess)) {
      throw new Error(`fastener: the hole (${depth}) must be deeper than the recess for its head (${recess})`);
    }
    // Where the screw goes in: origin on the surface, Z out of the material.
    const frame = this.frameOf(this.values.at);
    const place = Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin);

    // Each cylinder stands on the XY plane; sink it below z = 0, then place it.
    /** @param {number} radius @param {number} length */
    const sunk = (radius, length) => {
      const cylinder = Primitives.makeCylinder(radius, length);
      const placed = ShapeOps.transform(cylinder, place.multiply(Matrix4.fromTranslation(0, 0, -length)));
      cylinder.dispose();
      return placed;
    };
    const tools = [sunk(screw.clearance / 2, depth)];
    if (recess > 0) {
      tools.push(sunk(screw.head / 2, recess));
    }
    return tools;
  }
}

export const fastener = defineFeature(Fastener, {
  label: 'Fastener hole',
  description: 'A screw clearance hole, plain or counterbored',
  icon: './fastener.svg',
  group: 'create',
  operations: ['remove'],
  call: ['at', { standard: 'standard', size: 'size', head: 'head', depth: 'depth' }],
  layout: [
    'at',
    'standard',
    'size',
    'head',
    { note: 'The recess is sized for the head of the screw.', visibleWhen: { head: 'counterbore' } },
    'depth',
  ],
});
