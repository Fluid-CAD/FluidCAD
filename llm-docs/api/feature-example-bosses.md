---
id: api/feature-example-bosses
title: "Example: bosses at connectors and sketch points — a custom feature with a union picker of locations"
summary: "A complete custom feature module and a model: bolt-pattern bosses, each a cylinder with a bore, standing at every location they are handed. Shows a ['connector', 'point', 'anchor'] union picker with multiple: true and anchors: ['center'], frameOf() for each location's frame (each boss grows along its Z), several tools returned from one statement, their faces sorted on XY, placed with transformTracking and named in the standard buckets, and a mounting plate with bosses at a connector, its copy and a sketch point, their top edges chamfered."
tags: [example, sdk, custom-feature, connector]
seeAlso: [api/feature, api/feature-params, api/connector, api/copy, api/sdk-kernel]
---

# Example: bosses at connectors and sketch points

A union picker of locations, `frameOf()` ([[api/feature]]), several tools
from one statement, and their buckets:

```feature.js
// boss.feature.js
// Bolt-pattern bosses — a cylinder with a bore — standing at every location
// they are handed: a connector, a point or a face centre.
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
      // One boss built on the XY plane, its faces sorted there, then placed
      // on the frame — growing along the frame's Z.
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
  group: 'create',
  operations: ['add', 'new'],
  call: ['at', { diameter: 'diameter', height: 'height', hole: 'hole' }],
});
```

A mounting plate with a connector, a copy of it, and a sketch point:

```fluid.js
import { part, sketch, line, point, extrude, connector, copy, select, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { face } from "fluidcad/filters";
import { boss } from "./boss.feature.js";

export const mountingPlate = part("Mounting plate", () => {
  sketch("xy", () => {
    const b = line([-31, -21], [29, -19]);
    const r = line([29, -19], [31, 21]);
    const t = line([31, 21], [-29, 19]);
    const l = line([-29, 19], [-31, -21]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -20]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 40);
  });
  const plate = extrude(6);

  // A connector at the centre of the top, and a copy of it 20 mm along x.
  const bolt = connector("bolt", select(face().planar().onPlane("xy", 6)));
  copy("linear", "x", { count: 2, offset: 20 }, bolt);

  const marks = sketch(plate.endFaces(), () => {
    const m1 = point([-20, 10]);
    fix(m1, [-20, 10]);
    return { m1 };
  });

  // Three bosses: at the connector, at its copy, and at the sketch point.
  const bosses = boss([bolt, bolt.instance(1), marks.geometries.m1], { height: 4 });
  chamfer(0.5, bosses.endEdges());
});
```
