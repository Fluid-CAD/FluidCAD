---
id: api/bezier
title: bezier(...points)
summary: Free-form bezier curve. The first point is the explicit start, the last is the endpoint; points in between are control points (degree = args − 1).
tags: [api, 2d, primitive, curve]
symbols: [bezier]
seeAlso: [api/arc, api/line]
---

# bezier

Imported from `fluidcad/core`.

```ts
bezier(...points: Point2D[])
```

The first argument is the explicit start, the last is the endpoint; any
arguments in between are control points. Sets the sketch cursor to the
endpoint.

| Args | Degree   | Shape                                |
|------|----------|--------------------------------------|
| 2    | 1 (line) | straight segment from start to end   |
| 3    | 2        | quadratic bezier (start, ctrl, end)  |
| 4    | 3        | cubic bezier (start, c1, c2, end)    |

## Example

```fluid.js
import { bezier, extrude, line, sketch } from "fluidcad/core";

sketch("xy", () => {
  line([0, 0], [0, 40]);
  bezier([0, 40], [20, 80], [80, 80], [100, 40]);   // cubic bezier
  line([0, 0]);
});
extrude(4);
```

See [[api/arc]] for circular curves with exact radii.
