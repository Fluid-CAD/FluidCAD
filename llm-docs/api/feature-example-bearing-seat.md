---
id: api/feature-example-bearing-seat
title: "Example: a bearing seat — a custom feature's named buckets through a remove"
summary: "A complete custom feature module and a model: a round pocket sunk into a planar face with the curated kernel, removing by default (operations ['remove', 'new']). Its named buckets are what the cut leaves: floorFaces the seat's floor, floorEdges (declared, not filled) its rim, wallFaces the bore; its startPlane lets the cut classify the mouth as a start edge. A plate for a 608 bearing fillets the floor's rim and chamfers the mouth; a seat deeper than the plate goes right through, leaving floorFaces() empty and the fillet failing its row."
tags: [example, sdk, custom-feature, buckets]
seeAlso: [api/feature-buckets, api/feature, api/sdk-kernel, api/fillet, api/chamfer]
---

# Example: a bearing seat, named buckets through a remove

A round pocket built with the curated kernel. It removes by default, so its
named buckets are what the cut leaves ([[api/feature-buckets]]):
`floorFaces` the seat's floor, `floorEdges` (declared, not filled) its rim,
`wallFaces` the bore. Its `startPlane` lets the cut classify the mouth as a
start edge:

```feature.js
// bearing-seat.feature.js
// A bearing seat: a round pocket sunk into a planar face, centred on it,
// built with the curated kernel. It removes by default.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class BearingSeat extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  diameter: { type: 'length', default: 22, min: 0 },
  depth: { type: 'length', default: 7, min: 0 },
}, {
  buckets: {
    floorFaces: {}, // the flat bottom the bearing rests on; none when the seat goes right through
    floorEdges: {}, // the rim round the floor, derived from floorFaces
    wallFaces: {}, // the bore the bearing presses into
  },
}) {
  static id = 'bearingSeat';

  buildTool() {
    const { diameter, depth } = this.values;
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`bearing seat: pick one planar face to sink it into (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());

    // Built on the XY plane from z = 0 to z = depth, its faces sorted there.
    const tool = Primitives.makeCylinder(diameter / 2, depth);
    const all = tool.getSubShapes('face');
    const tolerance = 1e-6 * Math.max(depth, diameter);
    const mouth = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
    const floor = all.filter(f => Math.abs(f.getBoundingBox().minZ - depth) < tolerance);
    const wall = all.filter(f => !mouth.includes(f) && !floor.includes(f));

    // Placed with its Z running into the material: the face's normal reversed.
    const into = plane.normal.negate();
    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection.negate(), into, origin);
    const placed = ShapeOps.transformTracking(tool, frame, all);
    tool.dispose();
    const [floorFaces, wallFaces] = [floor, wall]
      .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));

    this.setBuckets({
      floorFaces,
      wallFaces,
      // The cut classifies its own rims from it: the mouth is a start edge.
      startPlane: new Plane(origin, plane.xDirection, into),
    });
    return [placed.shape];
  }
}

export const bearingSeat = defineFeature(BearingSeat, {
  label: 'Bearing seat',
  description: 'A round pocket a bearing presses into, sunk into a planar face',
  group: 'modify',
  operations: ['remove', 'new'],
  call: ['face', { diameter: 'diameter', depth: 'depth' }],
});
```

```fluid.js
import { part, sketch, line, extrude, fillet, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { bearingSeat } from "./bearing-seat.feature.js";

// A 60 × 40 × 12 bearing plate with a seat for a 608 bearing (Ø22 × 7).
export const bearingPlate = part("Bearing plate", () => {
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
  const plate = extrude(12);

  const seat = bearingSeat(plate.endFaces(), { diameter: 22, depth: 7 });
  fillet(0.3, seat.floorEdges());      // a relief where the floor meets the bore
  chamfer(0.5, seat.startEdges());     // a lead-in at the mouth, a rim the cut classified
});
```

A seat deeper than the plate goes right through: its `floorFaces()` and
`floorEdges()` are empty, and the fillet on them fails its row with
`fillet: the selection resolved to no edges — nothing was filleted.`
