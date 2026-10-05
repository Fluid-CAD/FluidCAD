---
id: api/loft
title: loft(...profiles)
summary: Builds a smooth solid that blends between two or more profile sketches at different positions.
tags: [api, 3d, solid]
symbols: [loft]
seeAlso: [api/sketch, api/sweep, api/extrude]
---

# loft

Imported from `fluidcad/core`.

```ts
loft(...profiles: SceneObject[])
```

Returns `Loft` (extends `BooleanOperation`). Each profile is typically a
sketch on a different plane (or a face selection). The solid interpolates
between them in order.

Chain: `.connect(...)`, `.guides(...)`, `.startCondition(...)`,
`.endCondition(...)`, `.thin()`, plus the boolean scope methods. Direct accessors:
`startFaces`, `endFaces`, `sideFaces`, `startEdges`, `endEdges`,
`sideEdges`, `internalFaces`, `internalEdges`, `capFaces`, `capEdges`.

`.startCondition(type, magnitude?)` and `.endCondition(type, magnitude?)`
set how the surface leaves the first profile and arrives at the last:
`'none'` (default), `'normal'` (perpendicular to the profile plane) or
`'tangent'` (inside the profile plane, bulging outward). With `'tangent'`
every point of the profile leaves along the outline's own outward direction
at the same rate, and a corner leaves along its mitre so both sides meeting
there advance at that rate: the bulge keeps the profile's shape. With
`'tangent'` at both ends of a loft 60 long, two Ø80 circles give a round
barrel (radius 55 halfway up, all the way round), two 80 × 80 squares a
square barrel with sharp corners (110 across halfway up), and a rounded
rectangle bulges evenly along flats and corners. `magnitude` (default 1)
scales the takeoff; a negative value flips it, so a `'tangent'` end pinches
inward.

The side has one face per stretch of profile between the vertices that
change the outline: corners, and tangent junctions where the curvature
jumps (a line running into an arc). A circle or ellipse is one stretch, so
a loft between round profiles has one side face (`sideFaces()` returns
it), no side edge (`sideEdges()` is empty: the seam is not selectable) and
one closed rim per end (`startEdges()` / `endEdges()` are one edge each).
The rim is exact when every profile is a circle or ellipse, and
`edge().circle(d)` matches a circular one. A circle drawn as several arcs
still lofts as one face: its arc vertices leave no mark on the side unless
a `.connect(...)` is pinned to them.

Profiles are paired automatically. Profiles whose corners and junctions
come in the same number and order are joined vertex to vertex — corners
face corners, junctions face junctions — in the pairing that twists least:
a 60 × 30 rounded rectangle (r 5) lofted to a 30 × 40 one (r 8) has 8 side
faces, flat to flat and corner to corner, and two slots loft straight to
straight and end to end (4 side faces). If only the corners agree in
number (two or more), the corners are joined. Otherwise (a square and a
circle, a hexagon and a square) the profiles are matched by distance along
the outline, each from its seam, and a vertex of one profile splits the
side where it lands on the other. The seam sits on a vertex of every
profile that has one, so it never cuts a flat side in two; a circle or
ellipse has no vertex and is turned to face its neighbour's seam. A square
lofted to a circle, in either order, has 4 side faces, and the circle is
approximated (within 1e-4 mm) and cut into 4 arcs; `startEdges()` /
`endEdges()` return a rim whole, however it is split. `.connect(...)`
replaces the automatic pairing — see Vertex connections below.

A loft rebuilds its section edges as B-splines, so a lofted rounded
rectangle's straight segments and corner arcs are no longer stored as lines
and circles. Edge filters classify by geometry, so `edge().line()` and
`edge().arc(r)` still find them; a section the loft had to split (a circle
lofted to a rectangle) answers to `arc(r)` rather than `circle(d)`.

When the first profile lies on an existing solid's face, the fusion merges
the loft's start face into that face. `startEdges()` then names the junction
edges in the final solid (the usual fillet target), and `startFaces()` the
face the loft grew from.

## Example

```fluid.js
import { circle, line, loft, origin, plane, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, diameter, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

const bottom = sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
const top = sketch(plane("xy", { offset: 100 }), () => {
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
loft(bottom, top);
```

See [[api/sweep]] for path-driven solids and [[api/extrude]] for the
straight-pull case.

## Vertex connections

Each `.connect(p1, p2, ...)` joins one vertex from every profile, in profile
order. Repeat the call for more connections. Each connection becomes a loft
edge through all its vertices, splitting the side faces at that edge. The spans
between neighboring connections match only each other.

```js
loft(a, b)
  .connect(a.geometries.bottom.start(), b.geometries.right.start())
  .connect(a.geometries.top.start(), b.geometries.left.start());
```

Return named geometry from each sketch callback to use `.geometries`. You can
also pass world coordinates (`[x, y, z]`) or solid-edge endpoints such as
`e.endEdges(0).start()`. Sketch point references resolve through their own
planes, including offset and non-XY planes. A vertex of an `offset()` result
is named by edge index, `a.geometries.o.edge(2).start()` — the indices walk
the result from the offset of the first source edge, and an edit that changes
which corners are rounded (a sign flip) shifts them, as with any index-based
reference; see [[api/offset]].

A point taken from a `select(...)` needs the selection declared **before** the
loft statement. Written inside `.connect(...)` it runs after `loft(...)`, and
the loft reports an error. The same holds for a `select(...)` passed to
`.guides(...)`:

```js
const tip = select(edge().farthest('x'));
loft(a, b).connect(tip.end(), b.geometries.right.start());
```

Connections require closed, planar profiles with exactly one region each.
Every point must coincide with a profile vertex; points in the middle of edges
are refused. A full circle or ellipse has no usable vertex: draw arcs instead.
Duplicate vertices, missing points and crossed connections produce feature
errors. Connections compose with start/end conditions, guides and thin walls.
With guides, a rail may ride a connected vertex; a rail that crosses a
connection between two profiles is a feature error. With thin walls, each
connection is carried onto both walls: the sharp offset corner on one side,
and the crest of the rounding arc on the other (an edge runs along that
crest). Thin walls merge smooth junctions into one edge, so a thin loft can
only connect real profile corners — not the arc ends of a split circle.
