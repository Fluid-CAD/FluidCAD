// The standoff fixture, JavaScript copy: a PCB standoff — a cylinder boss
// with a bore through it — standing on a picked planar face. This is the
// file a project keeps as `standoff.feature.js`, written against the public
// entry points only. The TypeScript copy the lib tests build from is
// lib/tests/fixtures/custom-features/standoff.ts; keep the two in step.

import { Feature, parseCall, registerBuilder } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class Standoff extends Feature {
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
    const members = [...start, ...end, ...side, ...internal];
    const placed = ShapeOps.transformTracking(tube, frame, members);
    tube.dispose();
    const image = list => list.map(f => placed.images[members.indexOf(f)]);

    this.setBuckets({
      startFaces: image(start),
      endFaces: image(end),
      sideFaces: image(side),
      internalFaces: image(internal),
      startPlane: new Plane(origin, plane.xDirection, plane.normal),
    });
    return [placed.shape];
  }
}

const meta = {
  class: Standoff,
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  icon: './standoff.svg',
  group: 'create',
  kind: 'tool',
  operations: ['add', 'new'],
  params: {
    face: { picker: 'face', label: 'On face', surface: 'planar' },
    height: { type: 'length', default: 10, min: 0 },
    outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
    hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
  },
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
};

export const standoff = registerBuilder(
  context => (...args) => new Standoff(parseCall(meta, args)).addTo(context),
  { feature: meta },
);
