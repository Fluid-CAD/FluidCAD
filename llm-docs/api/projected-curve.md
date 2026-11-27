---
id: api/projected-curve
title: project(source, target)
summary: Outside a sketch, curves thrown onto faces — a logo or a parting line drawn flat and laid onto a curved body, a path on a surface, a guide that must lie on a face. Along one line both ways, or each point to the closest point of the faces; the options are chained methods.
tags: [api, 3d, curve, wire, projection]
seeAlso: [api/project-intersect, api/intersection-curve, api/helix, api/sweep, api/select, api/axis, api/plane]
---

# project (3D curve)

Imported from `fluidcad/core`. The same `project` that lays geometry onto
a sketch plane inside a sketch ([[api/project-intersect]]); written
**outside** a sketch, with two arguments, it throws curves onto faces and
builds a curve.

```ts
project(source: Curves | Curves[], target: Faces | Faces[]): IProjectedCurve
  .mode('direction' | 'normal')   // default 'direction'
  .direction(d)                    // mode 'direction' only
  .keep('nearest' | 'all')         // default 'nearest'
```

| Argument | Accepts |
|---|---|
| `source` | Curves: a sketch, a sketch statement, a curve object (a helix, an intersection curve, another projected curve), a selection of edges, or a list of those. |
| `target` | Faces: a face selection (faces of solids or of surfaces), a surface, a solid (all its faces), or a list of those. |

Whether the call sits inside a `sketch(…)` callback decides which tool it
is: inside, `project(obj)` keeps its sketch meaning.

## Options (chained methods, in any order)

| Method | Meaning |
|---|---|
| `.mode('direction')` | The default: every point of the source travels along one line, the one `.direction()` gives. |
| `.mode('normal')` | Every point goes to the closest point of the target faces. |
| `.direction(d)` | The line, for mode `'direction'`: `'x'`, `'y'`, `'z'`, an `axis()`, a straight edge (a `select(edge()…)`), a connector (its Z axis); or `'xy'`, `'xz'`, `'yz'`, a `plane()`, a planar face — for its normal. Left out, it is the normal of the plane the source lies in (a sketch's own plane, even for a single straight line). |
| `.keep('nearest')` | The default: along the direction, what the line through each point of the source meets nearest that point — the far side of a body is left out, every stretch of the near side stays. In mode `'normal'`, the image nearest the source. |
| `.keep('all')` | Every image: the far side of a closed body too. |

**The direction is a line, not an arrow.** The source is projected both
ways along it, and `keep` chooses which images stay. That is why there is
no flip: a sketch above a body and one below it both land on the side
facing them with the default `keep('nearest')`.

`.direction()` with `.mode('normal')` is an error, whatever order the two
are chained in. A selection given to `.direction()` is taken by the
projection, as an argument is: a later bare `fillet(2)` does not pick it up
as the last selection.

## Result

A curve object, like a `helix`: construction geometry, drawn as lines. It
holds one **wire per image chain** — an image that crosses two faces is one
wire of two edges, and one the kernel split at a closed face's seam is
chained back into one wire.

- `pc.edges()` — every edge, curve after curve, each in the order it runs.
- `pc.edges(0)`, `pc.edges(edge().arc())` — by index or by filter.
- `pc.start()`, `pc.end()` — where the (first) curve starts and ends.

Every image **runs the same way as its source**: an open image starts at
the image of the source's start (as far as the image reaches), and a closed
one runs round the way the source does. Images come in **source order**;
those of one source curve in the order they start along it, the nearest
first where they start together (with `keep('all')`: near side, then far
side).

An image the kernel stored as a B-spline that is analytically a line, a
circle or an ellipse reads as one (`edge().line()`, `edge().circle()`).
Every edge carries its curve on the face it lies on.

The source curves are **hidden and stay readable**: a later statement may
read the sketch or the curve again. The target is **read, not used up**:
solids and surfaces stay in the model, and a face selection's highlight
leaves the display while its faces stay readable. A tool that uses the
curve (a `sweep` along it) hides it, and it stays readable.

## Errors

| Situation | Message |
|---|---|
| Mode `'direction'`, no `.direction()`, and the source lies in no one plane (a helix) | `project: the source does not lie in a plane, so it has no natural direction.` Hint: `Add .direction(…), or use .mode('normal').` |
| `.direction(…)` with `.mode('normal')` | `project: .direction() is for mode 'direction'.` |
| `.mode(…)` outside its set (thrown where the statement is written) | `project: .mode() takes 'direction' or 'normal'.` |
| `.keep(…)` outside its set (thrown where the statement is written) | `project: .keep() takes 'nearest' or 'all'.` |
| Nothing lands on the target, or the direction runs along the faces, or the kernel leaves a broken image | `project: the projection misses the target.` Hint: `Along Z, no part of the source falls on the picked faces.` (the direction named) |
| The direction is a curved edge or face | `project: the direction is a curved edge; only a straight edge gives a direction.` (and similar) |
| The source is a solid or faces | `project: the source is a solid; pick the edges to use.` (and similar) |
| The target is a sketch or edges | `project: the target is a sketch; it needs faces.` (and similar) |
| Fewer than two arguments outside a sketch | `project: outside a sketch, give the curves to project and the faces to project them onto: project(source, target).` |

## Example: a ring dropped onto a ball

```fluid.js
import { sketch, circle, sphere, plane, project, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const ball = sphere(30);

// A ring drawn on a plane above the ball.
const ring = sketch(plane("xy", 50), () => {
  const c = circle([0, 0], 30);
  coincident(c.center(), origin());
  diameter(c, 30);
});

// Dropped along the sketch's normal: one closed curve on the top.
const mark = project(ring, ball);

// The same ring again (it stays readable), keeping the bottom image too.
const both = project(ring, ball).keep("all");
```

## Example: straight down, not along the sketch's normal

```fluid.js
import { sketch, circle, extrude, plane, project, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 80);
  coincident(c.center(), origin());
  diameter(c, 80);
});
const disc = extrude(10);

// A circle on a plane tilted 30°.
const tilted = sketch(plane("xy", { offset: 40, rotateX: 30 }), () => {
  const c = circle([0, 0], 30);
  coincident(c.center(), origin());
  diameter(c, 30);
});

// Along Z: an ellipse on the disc's top face.
const mark = project(tilted, disc.endFaces()).direction("z");
```

## Example: a helix laid onto a shaft, normal to its wall

```fluid.js
import { sketch, circle, extrude, helix, project, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
const shaft = extrude(60);

// A helix inside the shaft, around its axis.
const h = helix("z").radius(10).pitch(8).height(40);

// Each point to the closest point of the wall: a helix of the same pitch on
// the shaft's surface. A helix lies in no plane, so mode 'direction' would
// need a .direction().
const groove = project(h, shaft.sideFaces()).mode("normal");
```
