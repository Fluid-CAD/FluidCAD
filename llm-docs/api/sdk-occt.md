---
id: api/sdk-occt
title: "fluidcad/sdk/occt and this.occ(scope => …) — raw OpenCascade in a custom feature (unstable)"
summary: "For geometry the curated kernel can't build, a custom feature runs raw OpenCascade inside this.occ(({ oc, track, keep }) => …): every object constructed through scope.oc, and every method result handed to track(), is freed when the scope ends, except what it returns or keep()s and any shape the scene holds. fluidcad/sdk/occt exports getOC(), OccScope and the binding's types. Unstable and unchecked: a double free can crash the kernel for the whole engine session; the row fails, the engine is marked suspect and the page offers a restart."
tags: [api, sdk, custom-feature, occt, kernel, type]
symbols: [getOC, OccScope]
seeAlso: [api/feature, api/sdk-kernel, concepts/custom-features]
---

# fluidcad/sdk/occt and `this.occ()`

```ts
// In a Feature subclass (buildTool(), build() or ghost()):
this.occ<T>(fn: (scope: OccScope) => T): T

class OccScope {
  readonly oc: OpenCascadeInstance;    // the binding; every `new scope.oc.X(…)` belongs to the scope
  track<T>(object: T): T;              // a method's or static's result: the scope frees it too
  keep<T>(value: T): T;                // spare a value the code stores past the scope
}

import { getOC, OccScope } from 'fluidcad/sdk/occt';   // also: import type { TopoDS_Shape, gp_Pnt, … }
```

**Unstable, and unsafe by nature.** This is the engine's binding of
OpenCascade (`ocjs-fluidcad`) as it is: its classes, names and signatures
change with the binding, without notice, and a model using them builds only
on an engine with the same binding. Use it only for what
`fluidcad/sdk/kernel` can't build (see [[api/sdk-kernel]]) — a loft through
sections, a sweep, a box, an offset, a face's centre of mass.

## The scope frees what you make

The binding's objects live on the kernel's heap until freed, and a feature
builds on every render whose cache misses it and on every change in its
dialog's preview. Run raw code inside `this.occ(…)`:

- **Constructed through `scope.oc`** — `new oc.gp_Pnt(0, 0, 1)`,
  `new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6)` — is recorded and
  freed when the scope ends, returning or throwing.
- **Returned by a method or a static** (`maker.Shape()`,
  `oc.TopoDS.Wire(shape)`, `props.CentreOfMass()`) is yours to free too:
  hand it to `track()`. `track()` takes binding objects only: "occ():
  track() takes an object of the OpenCascade binding, got a Face wrapper —
  keep() it, or track() its getShape()".
- **Never freed:** what the scope returns (walked through arrays, maps, sets,
  plain objects and shape wrappers' raw handles), what it `keep()`s, and any
  raw shape a shape the scene holds points at — the feature's references and
  everything they depend on.
- Freeing runs in reverse order: an algorithm with a `Clear()` is cleared,
  then deleted; a handle (`Geom_*`, `Poly_*`, a history) and a `TopoDS_Shape`
  are nulled, then deleted.
- `keep`, `track` and `oc` are bound: destructure them,
  `this.occ(({ oc, track, keep }) => …)`.
- **Synchronous only.** An async function is refused ("occ(): the scope runs
  synchronously — …"), and constructing through a closed scope throws
  ("occ(): the scope has closed — keep raw OpenCascade code inside the
  function this.occ() runs").
- `getOC()` is the same instance **without** the scope: what it constructs
  is never freed for you.

Even the scope can't free everything: the binding's `delete()` skips the
C++ destructor, so an algorithm without a `Clear()` keeps some internals on
the heap. A long session grows a little.

Raw shapes come back into the kernel's wrappers with
`ShapeFactory.fromShape(raw)` (`fluidcad/sdk/kernel`), and a wrapper's raw
handle is `shape.getShape()`. Return wrappers from the scope; `buildTool()`
returns them and `setBuckets()` names their faces.

## When raw code goes wrong

Nothing checks raw code. An object freed twice, or a shape the model holds
freed from under it, corrupts the kernel's memory for the whole engine
session, not only for the feature. When that ends in a WebAssembly trap:

- the feature's row fails: "Twist crashed the OpenCascade kernel (memory
  access out of bounds). The engine's memory may be damaged: what it builds
  from now on is suspect until the engine restarts.", followed by "Twist uses
  raw OpenCascade (fluidcad/sdk/occt) — the likeliest cause: …" for a
  feature that uses it;
- the rest of the model builds, and the page shows a banner that offers
  **Restart engine** where the host can restart it (the desktop app,
  `fluidcad serve`) or says how;
- everything built after the trap is suspect until the restart.

**Completion in the editor.** The page loads the binding's 2 MB of type
declarations the first time an open file mentions `fluidcad/sdk/occt` or
`this.occ(`, so `oc.` completes in the in-page editor.

## Example: a twisted pen holder

A planar face's outline lofted up its normal through copies of itself, each
turned a little further about the normal through the face's centre, with an
optional bore cut down the middle:

```feature.js
// twist.feature.js
// A twisted extrusion of a planar face, built with raw OpenCascade.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { ShapeFactory } from 'fluidcad/sdk/kernel';

export class Twist extends Feature.with({
  face: { picker: 'face', label: 'Profile face', surface: 'planar' },
  height: { type: 'length', default: 20, min: 0 },
  angle: { type: 'angle', default: 90, label: 'Twist' },
  sections: { type: 'integer', default: 8, min: 2, max: 64 },
  bore: { type: 'length', default: 0, min: 0, label: 'Bore diameter' },
}) {
  static id = 'twist';

  buildTool() {
    const { face, height, angle, sections, bore } = this.values;
    const [profile] = this.facesOf(face);
    const outline = profile?.getOuterWire();
    if (!profile || !outline) {
      throw new Error('twist: pick the planar face to twist up from');
    }
    const n = profile.calculateNormal();

    const built = this.occ(({ oc, track }) => {
      // The axis: the face's normal through its centre.
      const props = new oc.GProp_GProps();
      oc.BRepGProp.SurfaceProperties(profile.getShape(), props, false, false);
      const centre = track(props.CentreOfMass());
      const up = new oc.gp_Dir(n.x, n.y, n.z);
      const axis = new oc.gp_Ax1(centre, up);

      // The outline, risen and turned a little further for each section.
      const loft = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
      // The sections are one outline turned, corner for corner: matching them
      // up again would pair a corner with its neighbour once a step passes half
      // the outline's symmetry and fold the column.
      loft.CheckCompatibility(false);
      for (let i = 0; i <= sections; i++) {
        const t = i / sections;
        const place = new oc.gp_Trsf();
        place.SetTranslation(new oc.gp_Vec(n.x * height * t, n.y * height * t, n.z * height * t));
        const turn = new oc.gp_Trsf();
        turn.SetRotation(axis, (angle * t * Math.PI) / 180);
        place.Multiply(turn);
        const section = track(outline.getShape().Moved(new oc.TopLoc_Location(place), false));
        loft.AddWire(track(oc.TopoDS.Wire(section)));
      }
      loft.Build(new oc.Message_ProgressRange());
      if (!loft.IsDone()) {
        throw new Error('twist: the loft through the sections failed');
      }

      let body = track(loft.Shape());
      if (bore > 0) {
        // A tool a little longer than the column at both ends, so the cut
        // leaves no sliver of either cap.
        const base = new oc.gp_Pnt(centre.X() - n.x, centre.Y() - n.y, centre.Z() - n.z);
        const tool = new oc.BRepPrimAPI_MakeCylinder(new oc.gp_Ax2(base, up), bore / 2, height + 2);
        const cut = new oc.BRepAlgoAPI_Cut(body, track(tool.Shape()), new oc.Message_ProgressRange());
        if (!cut.IsDone()) {
          throw new Error('twist: the bore could not be cut');
        }
        body = track(cut.Shape());
      }

      // The faces by where they stand: the caps on the face's plane and at
      // the top, the bore's wall inside, the twisted walls around.
      const solid = ShapeFactory.fromShape(body);
      const tolerance = 1e-6 * Math.max(1, height);
      const start = [], end = [], side = [], internal = [];
      for (const f of solid.getSubShapes('face')) {
        const type = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(f.getShape()), true).GetType();
        const c = f.center();
        const rise = (c.x - centre.X()) * n.x + (c.y - centre.Y()) * n.y + (c.z - centre.Z()) * n.z;
        if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane && Math.abs(rise) < tolerance) {
          start.push(f);
        } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane && Math.abs(rise - height) < tolerance) {
          end.push(f);
        } else if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
          internal.push(f);
        } else {
          side.push(f);
        }
      }
      // The solid wrapper is returned, so the scope spares its raw shape.
      return { solid, start, end, side, internal };
    });

    this.setBuckets({ startFaces: built.start, endFaces: built.end, sideFaces: built.side, internalFaces: built.internal });
    return [built.solid];
  }
}

export const twist = defineFeature(Twist, {
  label: 'Twist',
  description: 'A twisted extrusion of a planar face, with an optional bore — built with raw OpenCascade',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', angle: 'angle', sections: 'sections', bore: 'bore' }],
});
```

The twist sorts its faces by where they stand and names the standard
buckets. A raw algorithm usually knows more: a prism's
`Generated(edge)` is the face swept from that outline edge, so a feature can
tell its faces apart by the edge they came from and name buckets of its own
(`tipFaces`, `flankFaces`, declared with `Feature.with(params, { buckets })`).
The spur gear in [[api/feature]] does exactly that.

A pen holder: a hexagonal foot, 24 mm across its corners, and a column
twisting a third of a turn up from its top with a bore down the middle:

```fluid.js
import { part, sketch, line, extrude } from "fluidcad/core";
import { coincident, fix } from "fluidcad/constraints";
import { twist } from "./twist.feature.js";

export const penHolder = part("Pen holder", () => {
  sketch("xy", () => {
    const a = line([12, 0], [6, 10.392304845413264]);
    const b = line([6, 10.392304845413264], [-6, 10.392304845413264]);
    const c = line([-6, 10.392304845413264], [-12, 0]);
    const d = line([-12, 0], [-6, -10.392304845413264]);
    const e = line([-6, -10.392304845413264], [6, -10.392304845413264]);
    const f = line([6, -10.392304845413264], [12, 0]);
    coincident(a.end(), b.start());
    coincident(b.end(), c.start());
    coincident(c.end(), d.start());
    coincident(d.end(), e.start());
    coincident(e.end(), f.start());
    coincident(f.end(), a.start());
    fix(a.start(), [12, 0]);
    fix(b.start(), [6, 10.392304845413264]);
    fix(c.start(), [-6, 10.392304845413264]);
    fix(d.start(), [-12, 0]);
    fix(e.start(), [-6, -10.392304845413264]);
    fix(f.start(), [6, -10.392304845413264]);
  });
  const foot = extrude(6);

  twist(foot.endFaces(), { height: 60, angle: 120, sections: 12, bore: 14 });
});
```
