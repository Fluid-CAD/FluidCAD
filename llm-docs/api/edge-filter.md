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

- `.line(length?)` / `.notLine(...)`
- `.circle(diameter?)` / `.notCircle(...)`
- `.arc(radius?)` / `.notArc(...)`

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
import { extrude, fillet, rect, select, sketch } from "fluidcad/core";
import { edge } from "fluidcad/filters";

sketch("xy", () => rect(60, 60).centered());
const e = extrude(20);
select(edge().verticalTo("xy"));        // the 4 vertical corner edges
fillet(2);
```

See [[api/face-filter]] for the face counterpart and [[api/select]] for
how filters land in the implicit selection.
