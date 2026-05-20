---
id: api/face-filter
title: face() — face filter builder
summary: Chainable predicate builder for selecting faces by shape, orientation, position, topology, or source. Each chained call narrows the set (AND). Every predicate has a `.notX()` counterpart.
tags: [api, selection, filter]
symbols: [face]
seeAlso: [api/edge-filter, api/select, concepts/last-selection]
---

# face filter

```ts
face(): FaceFilterBuilder
```

Returns a chainable filter builder. Chain calls narrow the candidate set
(AND). Negate any criterion with the `not...` form.

## By shape

- `.planar()` / `.notPlanar()`
- `.cylinder(diameter?)` / `.notCylinder(...)`
- `.cylinderCurve(diameter?)` — faces bounded by cylindrical curves
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
sketch("xy", () => rect(100, 80).centered());
const e = extrude(30);
select(face().planar().onPlane("xy", 30));   // top face only
fillet(4);
```

See [[api/edge-filter]] for the edge counterpart and [[api/select]] for
how filters are consumed.
