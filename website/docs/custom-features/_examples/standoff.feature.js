// @screenshot skip
// A PCB standoff: a boss with a bore through it, standing on a planar face.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

// The values the feature takes: one picked face and three typed-in lengths.
// The dialog shows one row per value, in this order.
export class Standoff extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  height: { type: 'length', default: 10, min: 0 },
  outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
  hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
}) {
  // The feature's type: it names the feature in every timeline.
  static id = 'standoff';

  // Returns the solid the feature adds; FluidCAD fuses it with the part.
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

    // Built standing on the XY plane, its faces sorted there, then placed.
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

    // Name the faces, so later features can pick them: post.endEdges() below.
    this.setBuckets({
      startFaces,
      endFaces,
      sideFaces,
      internalFaces,
      startPlane: new Plane(origin, plane.xDirection, plane.normal),
    });
    return [placed.shape];
  }
}

// What the toolbar and the dialog show, and the call a model writes:
// standoff(face, { height, outer, hole }). Export it by name.
export const standoff = defineFeature(Standoff, {
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
});
