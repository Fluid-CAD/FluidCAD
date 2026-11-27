---
id: api/intersection-curve
title: intersect(first, second)
summary: Outside a sketch, the 3D curve where two sets of faces meet — a section to sweep along, the seam between two surfaces, a curve that follows a body. One wire per connected chain, in an order that stays put across rebuilds.
tags: [api, 3d, curve, wire, intersection]
seeAlso: [api/project-intersect, api/sweep, api/plane, api/select, api/load, api/helix]
---

# intersect (3D curve)

Imported from `fluidcad/core`. The same `intersect` that sections a sketch
plane inside a sketch ([[api/project-intersect]]); written **outside** a
sketch, with two arguments, it builds a curve.

```ts
intersect(first: Faces | Faces[], second: Faces | Faces[] | Plane): IIntersectionCurve
```

| Argument | Accepts |
|---|---|
| `first` | A face selection (faces of solids or of surfaces), a surface, a solid (all its faces), or a list of those. |
| `second` | The same, or one `plane()`, taken as infinite. |

Whether the call sits inside a `sketch(…)` callback decides which tool it
is: inside, `intersect(obj)` keeps its sketch meaning.

## Result

A curve object, like a `helix`: construction geometry, drawn as lines. It
holds one **wire per connected chain** of intersection edges — one closed
wire where a plane cuts a cylinder wall, two where two cylinders cross, an
open wire where two surfaces cross and end.

- `ic.edges()` — every edge, curve after curve, each in the order it runs.
- `ic.edges(0)`, `ic.edges(edge().arc())` — by index or by filter.
- `ic.start()`, `ic.end()` — where the (first) curve starts and ends.

The order does not follow the kernel's: wires come by the first-argument
face each starts on, then by start point; an open wire runs from its
lexicographically smaller end (x, then y, then z). So `ic.edges(1)` names
the same edge after an upstream dimension changes.

A cut that is analytically a circle or an ellipse reads as one (`edge().circle()`,
`edge().ellipse()`), even when the kernel stored it as a B-spline.

The faces are **read, not used up**: solids, surfaces and planes stay in
the model, and a face selection's highlight leaves the display while its
faces stay readable. A tool that uses the curve (a `sweep` along it) hides
it, and it stays readable by later statements.

## Errors

| Situation | Message |
|---|---|
| The two sides do not cross: they only touch — along an edge, tangentially, or lying on each other | `intersect: the two selections do not cross.` Hint: `Faces that only touch along an edge, or lie on top of each other, have no intersection curve.` |
| A face is on both sides | `intersect: the <kind> face at (x, y, z) is in both selections.` |
| An argument holds edges, a curve or a sketch | `intersect: the first selection is an edge selection; it needs faces.` (and similar) |
| A `plane()` as the first argument, or in a list | `intersect: a plane can only be the second argument, given on its own.` |
| The curves branch (two equal cylinders crossing) | `intersect: the intersection branches at (x, y, z): 4 of its edges meet there.` |
| The result breaks off inside both sides (tangent contact) | `intersect: the intersection breaks off at (x, y, z), inside both selections.` |
| Fewer than two arguments outside a sketch | `intersect: outside a sketch, give the two sets of faces to intersect: intersect(first, second).` |

## Example: a cylinder cut by a tilted plane

```fluid.js
import { sketch, circle, extrude, intersect, plane, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
const body = extrude(60);

// Where the wall meets a plane tilted 30°: one closed ellipse.
const ic = intersect(body.sideFaces(), plane("xy", { offset: 30, rotateX: 30 }));
```

## Example: two rails along a pipe

```fluid.js
import { sketch, circle, extrude, intersect, plane, origin, sweep } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("yz", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
const pipe = extrude(100);

// A plane 10 above the pipe's axis cuts its wall along two straight lines:
// two open wires, each from one end of the pipe to the other.
const rails = intersect(pipe.sideFaces(), plane("xy", 10));

// A Ø3 rod along the first one, from a plane square to its start.
const rod = sketch(plane(rails.edges(0), "start"), () => {
  const c = circle([0, 0], 3);
  coincident(c.center(), origin());
  diameter(c, 3);
});
sweep(rails.edges(0), rod);
```
