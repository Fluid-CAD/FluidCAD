---
id: api/feature-example-gear
title: "Example: a spur gear with named buckets — faces told apart by the outline edge they were swept from"
summary: "A complete custom feature module and a model: a straight-flank spur gear standing on a planar face, centred on it, with a shaft bore. Its outline is raw OpenCascade in this.occ() (the curated kernel draws no outline), extruded with BRepPrimAPI_MakePrism; prism.Generated(edge) tells each face by the outline edge it was swept from, so it fills the standard buckets and its own named ones (tipFaces, flankFaces, rootFaces, boreFaces), with tipEdges and boreEdges declared and derived. A gear pair on a base plate, each gear a body of its own, rounds its tooth tips through g.tipEdges() and chamfers the wheel's bore rims through wheel.boreEdges()."
tags: [example, sdk, custom-feature, occt, buckets]
seeAlso: [api/feature-buckets, api/feature, api/sdk-occt, api/sdk-kernel, api/fillet, api/chamfer]
---

# Example: a spur gear with named buckets

The gear tells its faces apart by the outline edge each one was swept from
(`prism.Generated(edge)`, see [[api/sdk-occt]]), fills the standard buckets
and its own ([[api/feature-buckets]]), and derives `tipEdges` and
`boreEdges` from their faces:

```feature.js
// gear.feature.js
// A spur gear with straight flanks — a disc of `teeth` trapezoid teeth round
// a shaft bore — standing on a planar face, centred on it. Its tips, flanks,
// roots and bore are named buckets. The outline is raw OpenCascade
// (this.occ()): the curated kernel draws no outline.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { ShapeFactory, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

/** The flanks' slant from the tooth's centre line: the old 14.5° rack, which keeps a root land down to ten teeth. */
const FLANK_ANGLE = (14.5 * Math.PI) / 180;

export class Gear extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar', description: 'The planar face the gear stands on, centred on it' },
  teeth: { type: 'integer', default: 20, min: 10, max: 120, description: 'How many teeth go round the gear' },
  module: { type: 'length', default: 2, min: 0.2, description: 'The tooth size: the pitch diameter over the number of teeth' },
  thickness: { type: 'length', default: 8, min: 0, description: 'How far the gear stands off the face' },
  bore: { type: 'length', default: 8, min: 0, label: 'Bore diameter', description: 'The shaft hole through the middle; 0 leaves it solid' },
}, {
  // What the gear names, in the order the editor tries them.
  buckets: {
    tipFaces: {}, // the top land of every tooth, one per tooth, in tooth order
    tipEdges: {}, // the edges round the tip faces: where a fillet rounds the tooth tips
    flankFaces: {}, // the tooth flanks, two per tooth, in tooth order
    rootFaces: {}, // the bottom land between neighbouring teeth
    boreFaces: {}, // the wall of the shaft hole
    boreEdges: { label: 'Bore Rims' }, // the rims of the shaft hole, top and bottom
  },
}) {
  static id = 'gear';

  buildTool() {
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`gear: pick one planar face to stand on (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());
    const body = this.occ(scope => Gear.#body(scope, this.values));

    // Placed on the face, centred on it, growing along its normal.
    const all = body.solid.getSubShapes('face');
    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
    const placed = ShapeOps.transformTracking(body.solid, frame, all);
    body.solid.dispose();
    /** @param {number[]} indices */
    const imagesOf = indices => indices.map(i => placed.images[i]).filter(f => f !== null);
    const tipFaces = imagesOf(body.faces.tip);
    const flankFaces = imagesOf(body.faces.flank);
    const rootFaces = imagesOf(body.faces.root);
    const boreFaces = imagesOf(body.faces.bore);
    this.setBuckets({
      startFaces: imagesOf(body.faces.start),
      endFaces: imagesOf(body.faces.end),
      sideFaces: [...flankFaces, ...tipFaces, ...rootFaces],
      internalFaces: boreFaces,
      tipFaces, flankFaces, rootFaces, boreFaces,
    });
    return [placed.shape];
  }

  /**
   * The gear's outline on the XY plane, extruded along Z: for each tooth, a
   * flank, the tip land, the other flank, then the root land to the next
   * tooth, all on shared vertices so the wire takes the edges as they are.
   * The faces are told apart by the outline edge each one was swept from.
   *
   * @param {import('fluidcad/sdk/occt').OccScope} scope
   * @param {{ teeth: number, module: number, thickness: number, bore: number }} values
   */
  static #body({ oc, track }, { teeth, module, thickness, bore }) {
    const pitch = (module * teeth) / 2;
    const tip = pitch + module;
    const root = pitch - 1.25 * module;
    // Half the tooth's width, across its centre line, at the tip and at the root.
    const tipHalf = (Math.PI * module) / 4 - module * Math.tan(FLANK_ANGLE);
    const rootHalf = (Math.PI * module) / 4 + 1.25 * module * Math.tan(FLANK_ANGLE);
    const step = (2 * Math.PI) / teeth;
    if (step - 2 * Math.asin(rootHalf / root) <= 0) {
      throw new Error(`gear: ${teeth} teeth leave no room between them — give it more teeth`);
    }
    if (bore > 0 && bore / 2 >= root - module) {
      throw new Error(`gear: the bore (${bore}) leaves no rim under the teeth — keep it under ${(2 * (root - module)).toFixed(2)}`);
    }

    /** @param {number} radius @param {number} half @param {number} angle */
    const vertex = (radius, half, angle) => {
      const along = Math.sqrt(radius * radius - half * half);
      const x = along * Math.cos(angle) - half * Math.sin(angle);
      const y = along * Math.sin(angle) + half * Math.cos(angle);
      return track(new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(x, y, 0)).Vertex());
    };
    const axis = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1));
    const tipCircle = new oc.gp_Circ(axis, tip);
    const rootCircle = new oc.gp_Circ(axis, root);

    const corners = Array.from({ length: teeth }, (_, i) => ({
      rootIn: vertex(root, -rootHalf, i * step),
      tipIn: vertex(tip, -tipHalf, i * step),
      tipOut: vertex(tip, tipHalf, i * step),
      rootOut: vertex(root, rootHalf, i * step),
    }));
    const wire = new oc.BRepBuilderAPI_MakeWire();
    /** @type {{ role: 'flank' | 'tip' | 'root', edge: import('fluidcad/sdk/occt').TopoDS_Edge }[]} */
    const roles = [];
    /** @param {'flank' | 'tip' | 'root'} role @param {import('fluidcad/sdk/occt').TopoDS_Edge} edge */
    const add = (role, edge) => {
      wire.Add(track(edge));
      roles.push({ role, edge: track(wire.Edge()) });
    };
    corners.forEach((c, i) => {
      const next = corners[(i + 1) % teeth];
      add('flank', new oc.BRepBuilderAPI_MakeEdge(c.rootIn, c.tipIn).Edge());
      add('tip', new oc.BRepBuilderAPI_MakeEdge(tipCircle, c.tipIn, c.tipOut).Edge());
      add('flank', new oc.BRepBuilderAPI_MakeEdge(c.tipOut, c.rootOut).Edge());
      add('root', new oc.BRepBuilderAPI_MakeEdge(rootCircle, c.rootOut, next.rootIn).Edge());
    });
    if (!wire.IsDone()) {
      throw new Error('gear: the outline did not close');
    }

    const face = new oc.BRepBuilderAPI_MakeFace(track(wire.Wire()), true);
    /** @type {import('fluidcad/sdk/occt').TopoDS_Edge | null} */
    let boreEdge = null;
    if (bore > 0) {
      boreEdge = track(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Circ(axis, bore / 2)).Edge());
      const boreWire = track(new oc.BRepBuilderAPI_MakeWire(boreEdge).Wire());
      // A hole runs the other way round from the outline.
      face.Add(track(oc.TopoDS.Wire(track(boreWire.Reversed()))));
    }
    const prism = new oc.BRepPrimAPI_MakePrism(track(face.Face()), new oc.gp_Vec(0, 0, thickness), false, true);
    if (!prism.IsDone()) {
      throw new Error('gear: the extrusion failed');
    }

    const solid = ShapeFactory.fromShape(track(prism.Shape()));
    const all = solid.getSubShapes('face');
    /** @param {import('fluidcad/sdk/occt').TopoDS_Shape} raw */
    const indexOf = raw => all.findIndex(f => f.getShape().IsSame(raw));
    /** @param {import('fluidcad/sdk/occt').TopoDS_Edge} edge */
    const sweptFrom = edge => {
      const list = track(prism.Generated(edge));
      /** @type {number[]} */
      const found = [];
      for (; list.Size() > 0; list.RemoveFirst()) {
        const at = indexOf(track(list.First()));
        if (at >= 0) {
          found.push(at);
        }
      }
      return found;
    };
    /** @type {Record<'start' | 'end' | 'tip' | 'flank' | 'root' | 'bore', number[]>} */
    const faces = {
      start: [indexOf(track(prism.FirstShape()))],
      end: [indexOf(track(prism.LastShape()))],
      tip: [],
      flank: [],
      root: [],
      bore: boreEdge ? sweptFrom(boreEdge) : [],
    };
    for (const { role, edge } of roles) {
      faces[role].push(...sweptFrom(edge));
    }
    return { solid, faces };
  }
}

export const gear = defineFeature(Gear, {
  label: 'Gear',
  description: 'A spur gear with straight flanks and a shaft bore, standing on a planar face',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { teeth: 'teeth', module: 'module', thickness: 'thickness', bore: 'bore' }],
});
```

A gear pair on a base plate, each gear a body of its own, its tooth tips
rounded through its own bucket:

```fluid.js
import { part, sketch, line, circle, extrude, fillet, chamfer } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, diameter, fix } from "fluidcad/constraints";
import { gear } from "./gear.feature.js";

// A gear pair on a 120 × 70 × 6 base plate: an 18-tooth pinion and a 31-tooth
// wheel, module 2, on round seats 50 mm apart (the sum of their pitch radii,
// 49, and 1 mm of backlash).
export const gearPair = part("Gear pair", () => {
  sketch("xy", () => {
    const b = line([-61, -36], [59, -34]);
    const r = line([59, -34], [61, 36]);
    const t = line([61, 36], [-59, 34]);
    const l = line([-59, 34], [-61, -36]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-60, -35]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 70);
  });
  extrude(6);

  // The two seats, 2 mm proud of the plate.
  sketch("xy", () => {
    const s = circle([-25, 0], 9);
    fix(s.center(), [-25, 0]);
    diameter(s, 20);
  });
  const pinionSeat = extrude(8);
  sketch("xy", () => {
    const s = circle([25, 0], 14);
    fix(s.center(), [25, 0]);
    diameter(s, 30);
  });
  const wheelSeat = extrude(8);

  // Each gear a body of its own on its seat, its tooth tips rounded.
  const pinion = gear(pinionSeat.endFaces(), { teeth: 18 }).new();
  fillet(0.3, pinion.tipEdges());
  const wheel = gear(wheelSeat.endFaces(), { teeth: 31 }).new();
  fillet(0.3, wheel.tipEdges());
  chamfer(0.5, wheel.boreEdges());
});
```
