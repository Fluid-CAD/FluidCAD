---
id: api/arc
title: arc(end) / arc(radius, startAngle, endAngle)
summary: Circular arc. Point form runs from the cursor (or explicit start) to `end`; angle form sweeps an angular range. Angles are relative to the current tangent and in degrees.
tags: [api, 2d, primitive, curve]
symbols: [arc]
seeAlso: [api/circle, api/bezier, api/line]
---

# arc

Imported from `fluidcad/core`.

```ts
arc(endPoint: Point2D)                        // from cursor through implicit center
arc(startPoint, endPoint)
arc(radius, startAngle?, endAngle?)           // angle form (defaults 0..180)
arc(targetPlane, endPoint)
arc(targetPlane, startPoint, endPoint)
arc(targetPlane, radius, startAngle, endAngle)
```

## Point form — `ArcPoints`

- `.radius(value)` — bulge radius. Positive bulges CCW; negative bulges CW.
- `.center(point)` — fix the center explicitly (mutually exclusive with `.radius()`).

## Angle form — `ArcAngles`

- `.centered()` — center the sweep around the start angle.
- Angles are degrees, relative to the **current tangent**.

## Example

```fluid.js
import { arc, extrude, line, sketch } from "fluidcad/core";

sketch("xy", () => {
  line([0, 0], [60, 0]);
  arc([100, 40]).radius(50);   // bulge from cursor to (100,40)
  line([100, 60]);
  line([0, 60]);
  line([0, 0]);
});
extrude(5);
```

See [[api/circle]] for full circles and [[api/bezier]] for free curves.
