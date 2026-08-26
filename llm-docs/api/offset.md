---
id: api/offset
title: offset(distance?, ...targets?)
summary: Offsets sketch geometry (or a coplanar face outline) outward (positive) or inward (negative). Use `.close()` to cap an open offset; mark sources `.guide()` to keep them out of the profile.
tags: [api, 2d, modifier]
symbols: [offset]
seeAlso: [api/sketch, api/extrude, api/project-intersect]
---

# offset

Imported from `fluidcad/core`.

```ts
offset(distance?)                      // whole sketch (or preceding select(...))
offset(distance, ...targets)           // geometries, accessors, or edge filters
offset(distance, ...faceSelections)    // outside a sketch: coplanar face targets
```

Returns `Offset`. Default distance is `1`. Chain `.close()` to cap an
open offset into a closed wire ready for extrusion. Positive distances
push outward (relative to wire winding); negative pushes inward.

With no targets, the whole sketch is offset — unless a sketch-scoped
`select(...)` precedes it, which is consumed as the implicit target.
Explicit targets narrow the offset to specific geometry: statements,
projected references, or edge filters (`edge().arc()`).

There is no `removeOriginal` flag — when only the offset should
contribute to the profile, mark the source geometry `.guide()`
(construction geometry stays out of profiles).

```fluid.js
import { circle, extrude, offset, sketch } from "fluidcad/core";

sketch("xy", () => {
  const c = circle([0, 0], 40);
  offset(5, c);               // source + offset → a ring profile (washer)
});
extrude(4);
```

## Offsetting faces (outside a sketch)

Called at top level with face targets — a `select(face()...)` result or a
solid op's face accessor like `body.endFaces()` — `offset` creates the
offset outline on the face's own plane. All wires of each face offset
together with region semantics: a positive distance grows the outline
outward and shrinks holes; negative shrinks the outline and grows holes.
Multiple faces must be coplanar. With no explicit target, the preceding
top-level `select(...)` is used. `.close()` is not valid for face
targets. The result is extrudable like any sketch.

```fluid.js
import { circle, extrude, offset, sketch } from "fluidcad/core";

sketch("xy", () => circle([0, 0], 60));
const body = extrude(20);

const rim = offset(3, body.endFaces());  // outline 3mm outside the top face
extrude(5, rim);                          // extrude it like a sketch
```

## Example

```fluid.js
import { extrude, line, offset, sketch } from "fluidcad/core";

sketch("xy", () => {
  line([-30, -20], [30, -20]);
  line([30, -20], [30, 20]);
  line([30, 20], [-30, 20]);
  line([-30, 20], [-30, -20]);
  offset(5);                  // 5mm outward offset of the whole sketch
});
extrude(4);
```

See [[api/sketch]] for the parent context and [[api/extrude]] for the
typical follow-up.
