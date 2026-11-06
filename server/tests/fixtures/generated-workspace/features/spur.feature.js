// A gear-like feature for a generated part: a plain disc of the gear's tip
// diameter, `width` deep, standing on the XY plane at the origin, its `axis`
// frame at the disc's centre. Its style select shows pictures beside this
// module; definePart() borrows its dialog.

import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives } from 'fluidcad/sdk/kernel';
import { Plane } from 'fluidcad/math';

export class Spur extends Feature.with({
  teeth: { type: 'integer', default: 24, min: 4, max: 400, description: 'The number of teeth round the gear.' },
  module: { type: 'length', default: 2, min: 0.1, description: 'The tooth size: the pitch diameter over the teeth.' },
  width: { type: 'length', default: 10, min: 0.01, label: 'Face width', description: 'How deep the gear is, along its axis.' },
  style: {
    type: 'select', default: 'spur', label: 'Style', display: 'grid', columns: 2,
    description: 'The tooth form.',
    options: [
      { label: 'Spur', value: 'spur', image: './img/spur.svg' },
      { label: 'Helical', value: 'helical', image: './img/helical.svg' },
    ],
  },
}, { frames: { axis: { label: 'Gear axis' } } }) {
  static id = 'spur';

  buildTool() {
    const { teeth, module, width } = this.values;
    const radius = (module * (teeth + 2)) / 2;
    this.setFrames({ axis: Plane.XY() });
    return [Primitives.makeCylinder(radius, width)];
  }
}

export const spur = defineFeature(Spur, {
  label: 'Spur gear',
  description: 'A plain spur gear blank.',
  icon: './icons/spur.svg',
  group: 'create',
  operations: ['new', 'add'],
  layout: [{ section: 'Size', items: [{ row: ['teeth', 'module'] }, 'width'] }, 'style'],
  call: [{ teeth: 'teeth', module: 'module', width: 'width', style: 'style' }],
});
