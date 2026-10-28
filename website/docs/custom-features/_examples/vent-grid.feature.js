// @screenshot skip
// A grid of round vent holes cut into a panel, centred on a planar face.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

/** Long enough to cut through any panel. */
const THROUGH = 1000;

export class VentGrid extends Feature.with({
  // A pick: one planar face, clicked in the viewport.
  face: { picker: 'face', label: 'Panel face', surface: 'planar' },
  // A choice shown as two picture cards.
  pattern: {
    type: 'radio',
    display: 'cards',
    columns: 2,
    options: [
      { label: 'Grid', value: 'grid', image: './vent-grid/grid.svg' },
      { label: 'Staggered', value: 'staggered', image: './vent-grid/staggered.svg' },
    ],
  },
  // Whole numbers with − / + buttons, kept between min and max.
  rows: { type: 'integer', display: 'stepper', default: 4, min: 1, max: 40 },
  columns: { type: 'integer', display: 'stepper', default: 6, min: 1, max: 40 },
  // A length on a slider, with its unit and a line of help under it.
  pitch: { type: 'length', display: 'slider', default: 8, min: 2, max: 30, suffix: 'mm', hint: 'Centre to centre' },
  diameter: { type: 'length', label: 'Hole diameter', default: 5, min: 0.5 },
  // A checkbox, and a row that shows only while it is off.
  through: { type: 'boolean', display: 'checkbox', label: 'Through all', default: true },
  depth: { type: 'length', default: 2, min: 0.1, visibleWhen: { through: false } },
}) {
  static id = 'ventGrid';

  buildTool() {
    const { pattern, rows, columns, pitch, diameter, through, depth } = this.values;
    if (!(diameter < pitch)) {
      throw new Error(`vent grid: the holes (${diameter}) must be narrower than the pitch (${pitch})`);
    }
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`vent grid: pick one planar face (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());
    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
    const length = through ? THROUGH : depth;

    // One cylinder per hole, laid out on the XY plane round the origin and
    // sunk below z = 0, then placed on the face: one statement, one row.
    const tools = [];
    for (let row = 0; row < rows; row++) {
      // A staggered grid shifts every other row by half a pitch, both ways
      // from the centre so the whole grid stays centred.
      const shift = pattern === 'staggered' ? (row % 2 === 0 ? -pitch / 4 : pitch / 4) : 0;
      for (let column = 0; column < columns; column++) {
        const x = (column - (columns - 1) / 2) * pitch + shift;
        const y = (row - (rows - 1) / 2) * pitch;
        const hole = Primitives.makeCylinder(diameter / 2, length);
        tools.push(ShapeOps.transform(hole, frame.multiply(Matrix4.fromTranslation(x, y, -length))));
        hole.dispose();
      }
    }

    // The holes start on the face and grow into the panel: their rims on the
    // face become the feature's start edges, so grid.startEdges() chamfers them.
    this.setBuckets({ startPlane: new Plane(origin, plane.xDirection, plane.normal.negate()) });
    return tools;
  }
}

export const ventGrid = defineFeature(VentGrid, {
  label: 'Vent grid',
  description: 'A grid of round vent holes cut into a panel',
  icon: './vent-grid.svg',
  group: 'create',
  // It only cuts: no Add / New tabs, and no .remove() to write.
  operations: ['remove'],
  // The preview is cheap to build: draw it from the start, with no toggle.
  ghost: 'always',
  call: ['face', { pattern: 'pattern', rows: 'rows', columns: 'columns', pitch: 'pitch', diameter: 'diameter', through: 'through', depth: 'depth' }],
  // Rows and columns side by side, the depth rows under a heading, and a
  // drawing of what the pitch and the diameter measure beside the dialog.
  width: 'wide',
  layout: [
    'face',
    'pattern',
    { row: ['rows', 'columns'] },
    'pitch',
    'diameter',
    { section: 'Depth', items: ['through', 'depth'] },
  ],
  aside: [{ image: './vent-grid/dims.svg', alt: 'The pitch, centre to centre, and the hole diameter' }],
});
