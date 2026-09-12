---
id: api/face-filter
title: face() — face filter builder
summary: Chainable predicate builder for selecting faces by shape, orientation, position, topology, or source. Each chained call narrows the set (AND). Every predicate has a `.notX()` counterpart.
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
- `.circle(diameter?)` — flat disc faces

## By orientation & position

- `.onPlane(plane, offset?)` / `.notOnPlane(...)`
- `.parallelTo(plane)` / `.notParallelTo(...)`
- `.above(plane, offset?)` — entirely above
- `.below(plane, offset?)`
- `.intersectsWith(plane)` — faces that cross the plane

## By topology

- `.edgeCount(n)`
- `.hasEdge(...filtersOrObjects)`

## By source

- `.from(...sceneObjects)` — restrict to faces from those objects
  (recurses into containers).

## Example

```fluid.js
import { extrude, fillet, line, select, sketch } from "fluidcad/core";
import { face } from "fluidcad/filters";

sketch("xy", () => {
  line([-50, -40], [50, -40]);
  line([50, -40], [50, 40]);
  line([50, 40], [-50, 40]);
  line([-50, 40], [-50, -40]);
});
const e = extrude(30);
select(face().planar().onPlane("xy", 30));   // top face only
fillet(4);
```

See [[api/edge-filter]] for the edge counterpart and [[api/select]] for
how filters are consumed.
