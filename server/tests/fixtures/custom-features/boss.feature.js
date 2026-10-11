// The boss fixture, JavaScript copy: a bolt-pattern boss — a cylinder with a
// bore through it — standing at every location it is handed, whatever kind:
// a connector (`bolt`, `bolt.instance(2)`), a point (`s.geometries.c.center()`,
// `e.endEdges(0).start()`) or a face's centre (`e.endFaces().center()`). Each
// boss grows along its location's frame. This is the file a project keeps as
// `boss.feature.js`, written against the public entry points only. The
// TypeScript copy the lib tests build from is
// lib/tests/fixtures/custom-features/boss.ts; keep the two in step.

import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

export class Boss extends Feature.with({
  at: { picker: ['connector', 'point', 'anchor'], multiple: true, anchors: ['center'], label: 'At' },
  diameter: { type: 'length', default: 8, min: 0, label: 'Boss diameter' },
  height: { type: 'length', default: 6, min: 0 },
  hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
}) {
  static id = 'boss';

  buildTool() {
    const { at, diameter, height, hole } = this.values;
    if (!(hole < diameter)) {
      throw new Error(`boss: the hole (${hole}) must be narrower than the boss (${diameter})`);
    }
    if (at.length === 0) {
      throw new Error('boss: pick where the bosses stand — a connector, a point or a face centre');
    }
    const tolerance = 1e-6 * Math.max(height, diameter);
    const frames = at.map(location => this.frameOf(location));
    const bosses = frames.map(frame => {
      // One boss standing on the frame: built on the XY plane, its faces
      // sorted into buckets there, then placed — growing along the frame's Z.
      const cylinder = Primitives.makeCylinder(diameter / 2, height);
      const bore = hole > 0 ? Primitives.makeCylinder(hole / 2, height) : null;
      const solid = bore ? BooleanOps.cutShapes(cylinder, bore) : cylinder;
      if (bore) {
        cylinder.dispose();
        bore.dispose();
      }
      const all = solid.getSubShapes('face');
      const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
      const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
      const walls = all.filter(f => !start.includes(f) && !end.includes(f));
      const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
      const internal = walls.filter(f => !side.includes(f));

      const placement = Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin);
      const placed = ShapeOps.transformTracking(solid, placement, all);
      solid.dispose();
      // Each group as the faces it became once placed.
      const [startFaces, endFaces, sideFaces, internalFaces] = [start, end, side, internal]
        .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));
      return { shape: placed.shape, startFaces, endFaces, sideFaces, internalFaces };
    });
    this.setBuckets({
      startFaces: bosses.flatMap(b => b.startFaces),
      endFaces: bosses.flatMap(b => b.endFaces),
      sideFaces: bosses.flatMap(b => b.sideFaces),
      internalFaces: bosses.flatMap(b => b.internalFaces),
      startPlane: frames[0],
    });
    return bosses.map(b => b.shape);
  }
}

export const boss = defineFeature(Boss, {
  label: 'Boss',
  description: 'Bosses with a bore, standing at connectors, points and face centres',
  icon: './boss.svg',
  group: 'create',
  operations: ['add', 'new'],
  call: ['at', { diameter: 'diameter', height: 'height', hole: 'hole' }],
});
