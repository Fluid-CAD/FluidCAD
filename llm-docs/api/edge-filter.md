---
id: api/edge-filter
title: edge() — edge filter builder
summary: Chainable predicate builder for selecting edges by shape (line, arc, circle, ellipse, spline, closed, planar), orientation, position, parent face/object, topology (open rim, between two face groups, a face group's perimeter), or the kind of body they belong to. Like `face()`, chained calls AND together and `.notX()` negates.
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
- `.ellipse()` / `.notEllipse()` — elliptical edges, a full ellipse or an
  arc of one (the rim of a cylinder cut at a slant)
- `.spline()` / `.notSpline()` — free-form edges: a sketch spline's edge, a
  loft's or sweep's free-form rim, a helix
- `.closed()` / `.notClosed()` — edges that return to their start: a full
  circle, a full ellipse, a closed spline
- `.open()` / `.notOpen()` — edges whose ends are apart; the complement of
  `closed()`, so `edge().ellipse().open()` is the elliptical arcs
- `.planar()` / `.notPlanar()` — edges that lie in one plane. Every line,
  arc, circle and ellipse does; next to `spline()` it tells a spline drawn
  in a sketch from a helix or a curve winding through space. A spline
  counts when no point of it strays more than 1e-6 mm from the plane

Shape predicates classify by geometry, not by how the kernel stores the
curve. A loft or sweep rebuilds its section edges as B-splines — the straight
segments and rounded corners of a lofted rounded rectangle included — and an
imported STEP file often does the same; `line()`, `arc(r)`, `circle(d)` and
`ellipse()` still recognise them (within 1e-3 mm). Only an edge that traces
none of those is a `spline()`.

## By orientation

- `.parallelTo(plane)` / `.notParallelTo(...)`
- `.verticalTo(plane)` / `.notVerticalTo(...)` — perpendicular to the plane

A line is parallel to a plane when it runs along it, and vertical to it when
it runs along its normal. A circle or an arc is judged at a few points: its
tangent at its middle for `parallelTo`, the straight line between its ends
for `verticalTo`. Any other edge — an ellipse, a spline — is judged by the
one plane it lies in: `parallelTo(P)` holds when that plane is parallel to
`P`, and a curve that winds through space (a helix) lies in no plane and is
parallel to none. `verticalTo(P)` never holds for such a curve, since only a
straight edge can be perpendicular to a plane.

## By position

- `.onPlane(plane, offset?)` — accepts `{ offset, bothDirections, partial }`
- `.above(plane, offset?)`
- `.below(plane, offset?)`
- `.intersectsWith(sceneObject)` — edges that cross another scene
  object's edges

`onPlane` checks a line, a circle or an arc at its ends and middle. Any
other edge — an ellipse, a spline — is on a plane when the one plane it lies
in is that plane; a curve that lies in no plane is on none. With
`{ partial: true }` an edge is kept when either of its ends is on the plane.

`above` / `below` judge a line, a circle or an arc by its two end vertices,
and any other edge by its true extent along the plane's normal, so a spline
that sags below the plane between its ends is not `above` it. An edge lying
in the plane is on neither side. With `{ partial: true }` an edge is kept
when any of it is on that side.

## By parent

- `.belongsToFace(...filtersOrObjects)`
- `.from(...sceneObjects)`

## By body

- `.ofSolid()` — edges of solids only
- `.ofSurface()` — edges of surfaces only: their open rims and the edges
  between their faces

`select(edge())` reaches the edges of every solid and every surface in
scope. In a model that also holds a surface (an imported STEP surface, say),
a tool that only works on solids needs `.ofSolid()`:
`fillet(2, select(edge().line().ofSolid()))`. The two are each other's
complement, so there is no `notOfSolid()`. A curve (a helix, a curve in an
imported file) is never part of the candidates unless `.from(curve)` names
it, and its edges are of neither kind.

On a surface, `.convex()` / `.concave()` / `.smooth()` judge an edge between
two of its faces by the faces' normals as they point; an edge of the open
rim bounds one face and matches none of them.

## By loop

- `.outerOf(...filtersOrObjects)` / `.notOuterOf(...)` — edges on the outer
  loop of a face: a plate's outline without its bore rims, a thin loft's top
  rim without the wall's inner rim
- `.holeOf(...filtersOrObjects)` / `.notHoleOf(...)` — edges on a hole loop
  of a face: the bore rims, the inner rim

The face is given as face filters (`face().onPlane("xy", 10)`) or as a face
reference — a bucket accessor like `plate.endFaces()`, or a select(). A
reference is read for its surface, so the loop is taken from the face as it
is *now*: a fillet or a boolean that reshaped the rim after the referenced
feature built it does not break the selection. Loop membership is pure
topology — no tolerance, no radius, no length — so dimension edits cannot
break it either. Which loop an edge is on depends on the face: a bore rim
is a hole of the plate's top face and the outer loop of the bore's wall.

```fluid.js
import { chamfer, circle, cut, extrude, fillet, line, origin, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, diameter, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

// A cover plate: rounded outline, one bore through the middle.
sketch("xy", () => {
  const b = line([-40, -25], [40, -25]);
  const r = line([40, -25], [40, 25]);
  const t = line([40, 25], [-40, 25]);
  const l = line([-40, 25], [-40, -25]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 50);
});
const plate = extrude(6);
fillet(8, plate.sideEdges());                        // rounds the outline: the top rim is now 8 edges
sketch(plate.endFaces(), () => {
  const c = circle([0, 0], 20);
  coincident(c.center(), origin());
  diameter(c, 20);
});
cut();                                               // the bore
chamfer(1, select(edge().outerOf(plate.endFaces())));   // the 8 outline edges, bore left sharp
chamfer(0.5, select(edge().holeOf(plate.endFaces())));  // the bore rim only
```

## By topology

What stays true when a free-form model is edited is which things touch.
These predicates name edges by the faces around them — no size, no
position — so they hold through dimension edits, and they work the same on
solids and surfaces:

- `.boundary()` / `.notBoundary()` — the open rim of a surface: edges that
  bound exactly one face of their body. A solid has none, and a seam is
  never one. The same rule as a surface's `boundaryEdges()` bucket and the
  rim the viewport draws, so `select(edge().boundary())` is every open rim
  in the model
- `.between(a, b)` / `.notBetween(a, b)` — edges shared by a face of `a`
  and a different face of `b`, in either order. `between(face(), face())`
  is every interior edge and never a seam; an open rim is between nothing
- `.boundaryOf(...faces)` / `.notBoundaryOf(...)` — the perimeter of a
  group of faces: edges that bound exactly one face of the group. For one
  face, all its loops (`outerOf` / `holeOf` split them); for connected
  faces, their outline — what a fill or a ruled surface is built from; for
  groups apart from each other, each one's outline. Several arguments make
  one group

```js
edge().between(face().planar(), face().freeform())   // where flats meet free-form faces
edge().between(wall.sideFaces(), cap.faces())         // where two features' faces meet
edge().between(fl.faces(), face())                    // every edge where the fill meets anything
edge().boundaryOf(pocket.internalFaces())             // the mouth of a pocket
edge().boundaryOf(face().cylinder())                  // the rims of every cylindrical face group
```

The faces are given as for `outerOf()`: face filter builders, or a face
reference (a bucket accessor or a select()); `between()` also takes an
array for either side. A filter builder names the faces `select(builder)`
would name among the bodies in scope, its own `at()`, `withChain()` and
ranks included. A reference is read from the faces as they are *now*: a
face counts when it is the referenced face or lies on the same plane,
cylinder, cone, sphere or torus, so a fillet that rebuilt the face after the
referenced feature made it does not break the selection. A free-form face
has no surface to compare and is matched by identity only.

```fluid.js
import { chamfer, cut, extrude, line, select, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";
import { edge, face } from "fluidcad/filters";

// A 60 × 40 block with a 20 × 10 pocket sunk 8 into its top.
const rect = (w, h) => {
  const b = line([-w / 2, -h / 2], [w / 2, -h / 2]);
  const r = line([w / 2, -h / 2], [w / 2, h / 2]);
  const t = line([w / 2, h / 2], [-w / 2, h / 2]);
  const l = line([-w / 2, h / 2], [-w / 2, -h / 2]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), w);
  distance(r.start(), r.end(), h);
};
sketch("xy", () => rect(60, 40));
const block = extrude(20);
sketch(block.endFaces(), () => rect(20, 10));
const pocket = cut(8);
chamfer(1, select(edge().boundaryOf(pocket.internalFaces())));       // the pocket's mouth, 4 edges
chamfer(0.5, select(edge().between(block.sideFaces(), face().onPlane("xy"))));  // the bottom outline
```

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
how filters land in the implicit selection and how `at()`,
`withTangents()` and `withChain()` pick and grow it.
