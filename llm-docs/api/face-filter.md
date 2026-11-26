---
id: api/face-filter
title: face() — face filter builder
summary: Chainable predicate builder for selecting faces by shape, orientation, position, topology, source, or the kind of body they belong to. Each chained call narrows the set (AND). Shape, position and topology predicates have a `.notX()` counterpart.
tags: [api, selection, filter]
symbols: [face]
seeAlso: [api/edge-filter, api/select, concepts/last-selection]
---

# face filter

Imported from `fluidcad/filters`.

```ts
face(): FaceFilterBuilder
```

Returns a chainable filter builder. Chain calls narrow the candidate set
(AND). Negate any criterion with the `not...` form.

## By shape

- `.planar()` / `.notPlanar()`
- `.cylinder(diameter?)` / `.notCylinder(...)` — full cylinders, wrapping all
  the way around their axis: a hole's bore, a boss's wall
- `.cylinderCurve(diameter?)` / `.notCylinderCurve(...)` — partial cylinders:
  a fillet face, a pad's rounded corner, a bore cut open by a slot. A fillet
  of radius `r` is `cylinderCurve(2 * r)`

`cylinder()` never matches a fillet, and `cylinderCurve()` never matches a
bore — pick by whether the face closes on itself, not by its radius.
- `.cone()` / `.notCone()`
- `.torus(majorRadius?, minorRadius?)`
- `.sphere(diameter?)` / `.notSphere(...)` — a ball, a domed cap
- `.circle(diameter?)` — flat disc faces
- `.revolved()` / `.notRevolved()` — a spline profile turned around an
  axis, when it is no plane, cylinder, cone, sphere or torus
- `.extruded()` / `.notExtruded()` — the wall a spline or an ellipse sweeps
  when pushed along a straight line, when it is no plane or cylinder
- `.freeform()` / `.notFreeform()` — everything else: a loft between unlike
  sections, a sweep along a winding path, a sculpted imported surface

Shape predicates classify by geometry, not by how the kernel stores the
surface. A loft, a sweep or an imported STEP file often stores flat walls
and round bores as B-spline surfaces; `planar()`, `cylinder()`,
`cylinderCurve()`, `cone()`, `sphere()` and `torus()` still recognise them
(within 1e-3 mm), so `face().planar()` keeps the flat walls of a lofted
rounded rectangle. Only a face that traces none of those is `freeform()`.

## By orientation & position

- `.onPlane(plane, offset?)` / `.notOnPlane(...)`
- `.parallelTo(plane)` / `.notParallelTo(...)`
- `.facing(direction, within = 45)` / `.notFacing(...)` — the outward
  normal at the face's centre is within `within` degrees of `direction`
  (`'x'` … `'-z'`, a vector, or an axis)
- `.above(plane, offset?)` — entirely above
- `.below(plane, offset?)`
- `.intersectsWith(plane)` — faces that cross the plane

`facing()` works on every kind of face, which makes it the way to say "the
top of this free-form shape": `face().facing("z")` keeps a box's top and a
dome's upper faces and leaves out the walls; `face().facing("z", 10)` keeps
only what points nearly straight up. A surface's faces face the way the
surface is oriented. Under a repeat or a mirror the direction moves with the
copy.

`above` / `below` judge a face on a plane, cylinder, cone, sphere or torus
bounded by lines and circular edges by its boundary vertices. Any other face
is judged by how far it reaches along the plane's normal, so a free-form
face that bulges below the plane between its corners is not `above` it.

## By topology

- `.edgeCount(n)`
- `.hasEdge(...filtersOrObjects)`

## By source

- `.from(...sceneObjects)` — restrict to faces from those objects
  (recurses into containers).

## By body

- `.ofSolid()` — faces of solids only
- `.ofSurface()` — faces of surfaces only

`select(face())` reaches the faces of every solid and every surface in
scope, so in a model that holds both, `select(face().planar().ofSolid())`
keeps to the solid's faces and `select(face().ofSurface())` to the
surface's. The two are each other's complement: there is no `notOfSolid()`.

## Example

```fluid.js
import { extrude, fillet, line, origin, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";
import { face } from "fluidcad/filters";

sketch("xy", () => {
  const b = line([-50, -40], [50, -40]);
  const r = line([50, -40], [50, 40]);
  const t = line([50, 40], [-50, 40]);
  const l = line([-50, 40], [-50, -40]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 100);
  distance(r.start(), r.end(), 80);
});
const e = extrude(30);
select(face().planar().onPlane("xy", 30));   // top face only
fillet(4);
```

See [[api/edge-filter]] for the edge counterpart and [[api/select]] for
how filters are consumed.
