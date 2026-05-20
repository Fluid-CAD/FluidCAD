---
id: api/bezier
title: bezier(...points)
summary: Free-form bezier curve. The last point is the endpoint; preceding points are control points (degree = args − 1).
tags: [api, 2d, primitive, curve]
symbols: [bezier]
seeAlso: [api/arc, api/line]
---

# bezier

Imported from `fluidcad/core`.

```ts
bezier(...points: Point2D[])
```

The last argument is the endpoint; preceding arguments are control points.

| Args | Degree   | Shape              |
|------|----------|--------------------|
| 1    | 1 (line) | straight segment   |
| 2    | 2        | quadratic bezier   |
| 3    | 3        | cubic bezier       |

The curve starts from the current cursor and ends at the final argument;
intermediate arguments are control handles that shape the curve.

## Example

```fluid.js
import { bezier, extrude, line, sketch } from "fluidcad/core";

sketch("xy", () => {
  line([0, 0], [0, 40]);
  bezier([20, 80], [80, 80], [100, 40]);   // cubic bezier
  line([0, 0]);
});
extrude(4);
```

See [[api/arc]] for circular curves with exact radii.
