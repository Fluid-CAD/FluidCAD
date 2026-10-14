// The standoff fixture, JavaScript copy: a PCB standoff — a cylinder boss
// with a bore through it — standing on a picked planar face. This is the
// file a project keeps as `standoff.feature.js`, written against the public
// entry points only: the class declares its values with Feature.with(), so
// `this.values` is typed in the editor, and defineFeature() makes the builder
// a model calls. The TypeScript copy the lib tests build from is
// lib/tests/fixtures/custom-features/standoff.ts; keep the two in step.

import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class Standoff extends Feature.with({
  face: {
    picker: 'face', label: 'On face', surface: 'planar',
    description: "Exactly one planar face to stand on. The standoff is centred on the face's centre and grows along its normal, so pick a face sized for one standoff, such as a raised pad's top (pad.endFaces()).",
  },
  height: {
    type: 'length', default: 10, min: 0,
    description: 'How far the standoff rises from the face, along its normal: the gap the board sits above the face.',
  },
  outer: {
    type: 'length', default: 6, min: 0, label: 'Boss diameter',
    description: 'The outside diameter of the cylindrical boss. Must be larger than hole.',
  },
  hole: {
    type: 'length', default: 3, min: 0, label: 'Hole diameter',
    description: "The diameter of the bore, always through the boss's full height: about 3.2 for an M3 clearance hole, 2.5 for an M3 thread-forming screw. Must be smaller than outer.",
  },
}, {
  // What a model works on beside the standard buckets; docs/standoff.md says
  // what each holds.
  buckets: {
    boreFaces: {}, // the wall of the bore
    boreEdges: {}, // the bore's two rims, derived from boreFaces
  },
}) {
  static id = 'acme.standoff';

  buildTool() {
    const { height, outer, hole } = this.values;
    if (!(hole < outer)) {
      throw new Error(`standoff: the hole (${hole}) must be narrower than the boss (${outer})`);
    }
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`standoff: pick one planar face to stand on (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());

    // Built standing on the XY plane, classified there, then placed.
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

    this.setBuckets({
      startFaces,
      endFaces,
      sideFaces,
      internalFaces,
      boreFaces: internalFaces,
      startPlane: new Plane(origin, plane.xDirection, plane.normal),
    });
    return [placed.shape];
  }
}

export const standoff = defineFeature(Standoff, {
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  icon: './standoff.svg',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
});
