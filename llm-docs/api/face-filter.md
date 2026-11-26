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
- `.circle(diameter?)` — round flat faces: flat faces whose outer boundary
  is one full circle. Holes are ignored, so a washer is a `circle()` of its
  outer diameter; a half disc is not one
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

A size argument — `cylinder(d)`, `cylinderCurve(d)`, `sphere(d)`,
`torus(R, r)` — is matched exactly on a face the kernel stores as that
shape, and within 1e-3 mm on one recovered from a B-spline.

## By orientation & position

- `.onPlane(plane, offset?)` / `.notOnPlane(...)` — flat faces lying on the
  plane. A flat face stored as a B-spline counts, as for `planar()`; a
  curved face is on no plane
- `.parallelTo(plane)` / `.notParallelTo(...)` — flat faces parallel to the
  plane
- `.facing(direction, within = 45)` / `.notFacing(...)` — the face's mean
  outward normal is within `within` degrees of `direction` (`'x'` … `'-z'`,
  a vector, or an axis)
- `.above(plane, offset?)` — entirely above
- `.below(plane, offset?)`
- `.intersectsWith(plane)` — faces that cross the plane

`facing()` judges a face as a whole: by the mean of its outward normals over
its surface, weighted by area. A flat face faces along its normal, a slot's
half-round end faces its middle, and a dome faces straight out of its pole,
so `face().facing("z")` keeps a box's top and a dome and leaves out the
walls, and `face().facing("z", 10)` keeps only what faces nearly straight
up. It works on every kind of face, which makes it the way to say "the top
of this free-form shape".

A face whose normals cancel out faces nowhere: a bore, the wall of a round
boss, a whole sphere or torus. `facing()` never keeps such a face, whatever
the angle, and `notFacing()` always does — name it by shape instead
(`cylinder()`, `sphere()`). A surface's faces face the way the surface is
oriented. Under a repeat or a mirror the direction moves with the copy.

The direction must be one: `face().facing("xy")` throws, as a plane name is
not a direction (`farthest()`, `nearest()` and `nth()` refuse it too).

`above` / `below` judge a face on a plane, cylinder, cone, sphere or torus
bounded by lines and circular edges by its boundary vertices. Any other face
— one bounded by a spline or an ellipse, or a free-form one — is judged by
its true extent along the plane's normal, so a free-form face that bulges
below the plane between its corners is not `above` it. A flat face lying in
the plane is on neither side.

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
