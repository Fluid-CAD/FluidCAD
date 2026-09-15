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

Chain: `.thin()`, plus the boolean scope methods. Direct accessors:
`startFaces`, `endFaces`, `sideFaces`, `startEdges`, `endEdges`,
`sideEdges`, `internalFaces`, `internalEdges`, `capFaces`, `capEdges`.

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
