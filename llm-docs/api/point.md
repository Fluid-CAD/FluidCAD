---
id: api/point
title: point([x, y])
summary: A standalone 2D point entity — a constraint anchor, not profile geometry. Its coordinates are solver guesses.
tags: [api, 2d, primitive]
symbols: [point]
seeAlso: [api/line, api/circle, api/constraints, api/sketch]
---

# point

Imported from `fluidcad/core`.

```ts
point(position: Point2D)
```

Returns a solved point entity. It draws as a vertex marker and never
contributes edges to the profile — use it as a constraint anchor:
pin it with `fix`, place it with `coincident` / `midpoint` /
`symmetric`, or dimension from it with `distance`.

## Example

```fluid.js
import { circle, extrude, point, sketch } from "fluidcad/core";
import { coincident, diameter, fix } from "fluidcad/constraints";

sketch("xy", () => {
  const p = point([3, 4]);
  fix(p, [10, 10]);                 // the anchor
  const c = circle([12, 9], 30);
  coincident(p, c.center());        // circle centered on the anchor
  diameter(c, 44);
});
extrude(6);
```

See [[api/constraints]] for the constraint catalog and [[api/sketch]]
for the sketch datums (`origin()`, `xAxis()`, `yAxis()`) — often the
better anchor when the reference is the sketch frame itself.
