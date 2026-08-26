---
id: api/arc
title: arc(start, end, center)
summary: Circular arc specified by start, end, and center guesses. Sweeps counterclockwise by default — chain .cw() for the other side. Constrain with tangent/radius/coincident for exact geometry.
tags: [api, 2d, primitive, curve]
symbols: [arc]
seeAlso: [api/circle, api/bezier, api/line, api/constraints]
---

# arc

Imported from `fluidcad/core`.

```ts
arc(start: Point2D, end: Point2D, center: Point2D)
```

Returns a solved arc entity. All three points are **guesses** — internal
consistency rows reconcile them onto one circle, and constraints refine
the result. The sweep runs **counterclockwise** from start to end;
chain `.cw()` to sweep clockwise instead.

Accessors for constraint targets: `.start()`, `.end()`, `.center()`.
Chain `.guide()` for a construction arc. Size it with `radius(a, v)` or
`diameter(a, v)`; join it smoothly with `coincident` + `tangent`.

## Example — tangent line–arc junction

```fluid.js
import { arc, extrude, line, sketch } from "fluidcad/core";
import { coincident, tangent, horizontal, vertical, fix, radius, distance } from "fluidcad/constraints";

sketch("xy", () => {
  const l = line([0, 0], [48, 2]);
  const a = arc([48, 2], [70, 25], [50, 22]);
  const back = line([70, 25], [0, 25]);
  const left = line([0, 25], [0, 0]);
  coincident(l.end(), a.start());
  coincident(a.end(), back.start());
  coincident(back.end(), left.start());
  coincident(left.end(), l.start());
  tangent(l, a);
  horizontal(l);
  vertical(left);
  fix(l.start());
  radius(a, 20);
  distance(l.start(), l.end(), 50);
});
extrude(5);
```

The `coincident` at the junction joins the profile; `tangent(l, a)`
removes the kink; the `radius` dimension sizes the arc. Because the
radius to a tangent junction is perpendicular to the line, the solved
center sits straight above the join.

See [[api/circle]] for full circles, [[api/bezier]] for free curves, and
[[api/constraints]] for the constraint catalog.
