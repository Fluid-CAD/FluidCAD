---
id: api/offset
title: offset(distance?, ...targets?)
summary: "Offsets sketch geometry (or a coplanar face outline) outward (positive) or inward (negative); outside a sketch with `{ on: faces }`, a curve beside edges at a distance, lying on faces. Use `.close()` to cap an open offset; mark sources `.guide()` to keep them out of the profile."
tags: [api, 2d, 3d, modifier, curve]
symbols: [offset]
seeAlso: [api/sketch, api/extrude, api/project-intersect, api/projected-curve, api/intersection-curve, api/sweep, api/types/offset-curve]
---

# offset

Imported from `fluidcad/core`. One name, three tools; where and how the
call is written decides which:

| Written | Meaning |
|---|---|
| inside a `sketch(…)` callback | 2D offset of sketch geometry (below) |
| outside a sketch, with a trailing `{ on: faces }` | an **offset curve**: a curve beside edges at a distance, lying on the faces (see "Offsetting a curve along faces") |
| outside a sketch, without `{ on }` | the outline of coplanar faces, offset on their plane (see "Offsetting faces") |

```ts
offset(distance?)                      // whole sketch (or preceding select(...))
offset(distance, ...targets)           // geometries, accessors, or edge filters
offset(distance, ...faceSelections)    // outside a sketch: coplanar face targets
offset(distance, edges, { on: faces }) // outside a sketch: an offset curve on the faces
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

## Offsetting a curve along faces

Called outside a sketch with a trailing `{ on: faces }`, `offset` builds a
curve beside `edges` at a constant distance, lying on the faces: a line set
back from an edge of a body (where a trim, a groove or a two-tone split
runs), the inner boundary of a band along a rim, a curve beside a projected
or intersection curve on the same surface.

```ts
offset(distance: number, edges: Curves | Curves[], { on: Faces | Faces[] }): IOffsetCurve
```

| Argument | Accepts |
|---|---|
| `distance` | A length, not zero. Its sign picks the side (below). |
| `edges` | Curves: a selection of edges, a curve object (a helix, an intersection or projected curve, another offset curve), a sketch, or a list of those. They must lie on the faces. |
| `{ on }` | The faces the curve lies on: a face selection (faces of solids or of surfaces), a surface, a solid (all its faces), or a list of those. **Required**: it is what makes the call an offset curve. It is the only option. |

The distance is measured **straight through space**, not along the
surface: every point of the curve is `|distance|` from the edges. The
kernel finds the curve where the faces meet a tube of that radius round
the edges, so each edge of the result carries its curve on the face it
lies on, and on planes, cylinders and the like it stays exact: a line
beside a line, an arc concentric with an arc.

**The side.** Walk along the edges standing on the outside of the faces
(a surface's normal side): a positive distance goes to the **left**, a
negative one to the right. Edges along the **rim** of the faces — one face
beside each, as a body's top edges are with its side faces — are walked the
way that face's boundary runs, so a positive distance always goes **onto
the faces** from a rim. Any other edges (inside the faces, or along an edge
with faces on both sides) are walked as they run: a sketch line or a
projected curve as drawn, so left stays left across a crease. To flip,
change the sign.

At a corner of the edges the curve is rounded on its outside, by an arc
about the corner, and cut square on its inside, as a 2D offset is. An open
curve ends where the planes square to the edges at their ends meet the
faces; a closed one is a closed loop.

### The result

A curve object ([[api/types/offset-curve]]), like a `helix`: construction
geometry, drawn as lines. It holds **one wire per chain** of the edges, in
the order the chains come, each **running the same way as its source**.

- `oc.edges()` — every edge, curve after curve, each in the order it runs.
- `oc.edges(0)`, `oc.edges(edge().line())` — by index or by filter.
- `oc.start()`, `oc.end()` — where the (first) curve starts and ends.

A sketch or a curve given as the edges is **hidden and stays readable**: a
later statement may read it again. Edges of a body and the faces are
**read, not used up**: solids and surfaces stay in the model, and a
selection's highlight leaves the display while what it selects stays
readable. A selection written inside `{ on }` is taken by the offset: a
later bare `fillet(2)` does not pick it up as the last selection. A tool
that uses the curve (a `sweep` along it) hides it, and it stays readable.

### Errors

| Situation | Message |
|---|---|
| The edges do not lie on the faces | `offset: the edges do not lie on the faces given in { on }.` |
| `{ on }` is empty, or holds something that is not a scene object | `offset: { on } needs the faces the curve lies on.` |
| The options object has another key, or no `on` | `offset: the only option is { on: faces }.` |
| The distance is zero | `offset: the distance is zero.` |
| Nothing on that side of the edges lies on the faces at that distance | `offset: at this distance the curve leaves the faces.` |
| The distance is larger than a bend of the edges allows on that side (the curve would fold over itself), or the curve comes back in more than one piece | `offset: the distance is larger than the curve's tightest bend allows on this side.` Hint: `Use a smaller distance, or the other side.` |
| `{ on }` holds a sketch or edges; the edges are a solid or faces | `offset: { on } is a sketch; it needs faces.`, `offset: the source is a solid; pick the edges to use.` (and similar) |

### Example: a band below a rim

```fluid.js
import { sketch, circle, extrude, offset, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
const body = extrude(20);

// 3 mm below the top rim, on the side wall: from a rim, a positive
// distance goes onto the faces.
const band = offset(3, body.endEdges(), { on: body.sideFaces() });
```

### Example: set back from the edges of a top face

```fluid.js
import { sketch, line, extrude, offset, origin } from "fluidcad/core";
import { coincident, distance, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([0, 0], [60, 0]);
  const r = line([60, 0], [60, 40]);
  const t = line([60, 40], [0, 40]);
  const l = line([0, 40], [0, 0]);
  coincident(b.start(), origin());
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 40);
});
const plate = extrude(10);

// A loop 5 mm in from the top face's edges, its corners square.
const inset = offset(5, plate.endEdges(), { on: plate.endFaces() });
```

### Example: beside a curve projected onto a ball

```fluid.js
import { sketch, circle, sphere, plane, project, offset, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const ball = sphere(30);

const ring = sketch(plane("xy", 50), () => {
  const c = circle([0, 0], 30);
  coincident(c.center(), origin());
  diameter(c, 30);
});
const mark = project(ring, ball);

// 1.5 mm to each side of the projected ring, on the ball.
const above = offset(1.5, mark, { on: ball });
const below = offset(-1.5, mark, { on: ball });
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
