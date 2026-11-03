// A generator: a crate of a base and a lid hinged on it. Its `finish`
// select shows pictures beside this module (features/lib/img).

import { Generator } from 'fluidcad/sdk';
import { ShapeFactory } from 'fluidcad/sdk/kernel';

export class Crate extends Generator.with({
  width: { type: 'length', default: 40, min: 5, description: 'The crate across.' },
  depth: { type: 'length', default: 30, min: 5, description: 'The crate front to back.' },
  height: { type: 'length', default: 20, min: 5, description: 'The base, floor to rim.' },
  finish: {
    type: 'select', default: 'open', label: 'Finish', description: 'Whether the lid stands open.',
    options: [
      { label: 'Open', value: 'open', image: './img/open.svg' },
      { label: 'Closed', value: 'closed', image: './img/closed.svg' },
    ],
  },
}) {
  static id = 'crate';

  layout(g) {
    const { width, depth, height } = this.values;
    const base = g.part('base', {
      name: 'Base',
      inputs: { width, depth, height },
      connectors: { hinge: { origin: [0, depth, height], z: [1, 0, 0] } },
    }).grounded();
    const lid = g.part('lid', {
      name: 'Lid',
      inputs: { width, depth, height: 3 },
      connectors: { hinge: { origin: [0, depth, 0], z: [1, 0, 0] } },
    }).pose({ position: [0, 0, height] });
    g.mate('revolute', base.connectors.hinge, lid.connectors.hinge).limits(0, 110).name('Lid hinge');
    return { base, lid };
  }

  static build(type, inputs, ctx) {
    return [ctx.occ(({ oc, track }) => ShapeFactory.fromShape(track(new oc.BRepPrimAPI_MakeBox(inputs.width, inputs.depth, inputs.height).Shape())))];
  }
}
