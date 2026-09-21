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
import { circle, extrude, offset, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
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
import { circle, extrude, offset, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 60);
  coincident(c.center(), origin());
  diameter(c, 60);
});
const body = extrude(20);

const rim = offset(3, body.endFaces());  // outline 3mm outside the top face
extrude(5, rim);                          // extrude it like a sketch
```

## Naming offset edges from outside the sketch

An offset result has no named entities, so its vertices are addressed by
index: `o.edge(i)` is one edge of the result and `o.edge(i).start()`,
`.end()` and (on an arc) `.center()` are its points. Return the offset from
the sketch callback and use them wherever a point from outside the sketch is
accepted — a loft connection, a connector. They are not constraint targets:
constrain the source geometry instead.

The indices walk the result. Index 0 is the offset of the first source edge
in statement order (for an open offset, the offset of the chain's first
edge); the walk continues in that edge's own direction, and
`o.edge(i).end()` is `o.edge(i + 1).start()`. The arcs an outward offset
rounds corners with are ordinary steps of the walk. Several separate
sources offset to several wires, numbered one after the other in statement
order; `.close()` appends the cap at the walk's end, then the cap at its
start. Because the indices are positional, an edit that changes which
corners are rounded — flipping the sign, for one — shifts them, and a
reference then resolves to a different vertex, as any index-based reference
does.

```fluid.js
import { line, loft, offset, origin, plane, sketch } from "fluidcad/core";
import { coincident, distance, horizontal, vertical } from "fluidcad/constraints";

function square(size) {
  const b = line([0, 0], [size, 0]);
  const r = line([size, 0], [size, size]);
  const t = line([size, size], [0, size]);
  const l = line([0, size], [0, 0]);
  coincident(b.start(), origin());
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  distance(b.start(), b.end(), size);
  distance(r.start(), r.end(), size);
  return { b, r, t, l };
}

const base = sketch("xy", () => {
  const sides = square(40);
  for (const side of Object.values(sides)) {
    side.guide();                       // only the inset square forms the profile
  }
  return { o: offset(-5, sides.b, sides.r, sides.t, sides.l) };
});
const top = sketch(plane("xy", { offset: 30 }), () => square(40));

// The inset's first corner goes to the top square's second corner: a quarter twist.
loft(base, top)
  .connect(base.geometries.o.edge(0).start(), top.geometries.r.start())
  .connect(base.geometries.o.edge(1).start(), top.geometries.t.start());
```

## Example

```fluid.js
import { extrude, line, offset, origin, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-30, -20], [30, -20]);
  const r = line([30, -20], [30, 20]);
  const t = line([30, 20], [-30, 20]);
  const l = line([-30, 20], [-30, -20]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 40);
  offset(5);                  // 5mm outward offset of the whole sketch
});
extrude(4);
```

See [[api/sketch]] for the parent context and [[api/extrude]] for the
typical follow-up.
