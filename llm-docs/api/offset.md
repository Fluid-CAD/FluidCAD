---
id: api/offset
title: offset(distance?, removeOriginal?)
summary: Offsets the current sketch wire outward (positive) or inward (negative). Use `.close()` to cap an open offset.
tags: [api, 2d, modifier]
symbols: [offset]
seeAlso: [api/sketch, api/extrude]
---

# offset

Imported from `fluidcad/core`.

```ts
offset(distance?, removeOriginal?)
offset(distance, ...targets)           // geometries, accessors, or edge filters
offset(distance, ...faceSelections)    // outside a sketch: coplanar face targets
offset(targetPlane, distance, removeOriginal, ...sourceGeometries)
```

Returns `Offset`. Default distance is `1`. Chain `.close()` to cap an
open offset into a closed wire ready for extrusion. Positive distances
push outward (relative to wire winding); negative pushes inward.

With no targets, the whole sketch is offset — unless a sketch-scoped
`select(...)` precedes it, which is consumed as the implicit target.
Explicit targets narrow the offset to specific geometry: feature objects,
edge accessors (`r.edge('top')`), or edge filters (`edge().arc()`).

```fluid.js
import { circle, move, offset, sketch } from "fluidcad/core";

sketch("xy", () => {
  const c = circle(40);
  move([60, 0]);
  circle(20);
  offset(5, c);              // offset only the first circle
});
```

## Offsetting faces (outside a sketch)

Called at top level with face targets — a `select(face()...)` result or a
solid op's face accessor like `body.endFaces()` — `offset` creates the
offset outline on the face's own plane. All wires of each face offset
together with region semantics: a positive distance grows the outline
outward and shrinks holes; negative shrinks the outline and grows holes.
Multiple faces must be coplanar. With no explicit target, the preceding
top-level `select(...)` is used. `removeOriginal` and `.close()` are not
valid for face targets. The result is extrudable like any sketch.

```fluid.js
import { extrude, offset, rect, sketch } from "fluidcad/core";

sketch("xy", () => {
  rect(60, 40);
});
const body = extrude(20);

const rim = offset(3, body.endFaces());  // outline 3mm outside the top face
extrude(5, rim);                          // extrude it like a sketch
```

## Example

```fluid.js
import { extrude, offset, rect, sketch } from "fluidcad/core";

sketch("xy", () => {
  rect(60, 40).centered();
  offset(5);                  // 5mm outward offset
});
extrude(4);
```

See [[api/sketch]] for the parent context and [[api/extrude]] for the
typical follow-up.
