---
id: api/edge-filter
title: edge() — edge filter builder
summary: Chainable predicate builder for selecting edges by shape, orientation, position, or parent face/object. Like `face()`, chained calls AND together and `.notX()` negates.
tags: [api, selection, filter]
symbols: [edge]
seeAlso: [api/face-filter, api/select]
---

# edge filter

Imported from `fluidcad/filters`.

```ts
edge(): EdgeFilterBuilder
```

Returns a chainable edge filter. Chained predicates AND together.

## By shape

- `.line(length?)` / `.notLine(...)` — straight edges
- `.circle(diameter?)` / `.notCircle(...)` — full circles (a hole or boss rim)
- `.arc(radius?)` / `.notArc(...)` — circular arcs (a fillet's edge, a rounded corner)

Shape predicates classify by geometry, not by how the kernel stores the
curve. A loft or sweep rebuilds its section edges as B-splines — the straight
segments and rounded corners of a lofted rounded rectangle included — and an
imported STEP file often does the same; `line()`, `arc(r)` and `circle(d)`
still recognise them (within 1e-3 mm). An edge that is neither straight nor
circular (an ellipse's arcs, a free-form spline) matches none of the three.

## By orientation

- `.parallelTo(plane)` / `.notParallelTo(...)`
- `.verticalTo(plane)` / `.notVerticalTo(...)` — perpendicular to the plane

## By position

- `.onPlane(plane, offset?)` — accepts `{ offset, bothDirections, partial }`
- `.above(plane, offset?)`
- `.below(plane, offset?)`
- `.intersectsWith(sceneObject)` — edges that cross another scene
  object's edges

## By parent

- `.belongsToFace(...filtersOrObjects)`
- `.from(...sceneObjects)`

## Example

```fluid.js
import { extrude, fillet, line, origin, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

sketch("xy", () => {
  const b = line([-30, -30], [30, -30]);
  const r = line([30, -30], [30, 30]);
  const t = line([30, 30], [-30, 30]);
  const l = line([-30, 30], [-30, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 60);
});
const e = extrude(20);
select(edge().verticalTo("xy"));        // the 4 vertical corner edges
fillet(2);
```

See [[api/face-filter]] for the face counterpart and [[api/select]] for
how filters land in the implicit selection.
