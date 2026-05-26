---
id: api/circle
title: circle(diameter?)
summary: Draws a circle on the active sketch plane. The numeric argument is the diameter, not the radius.
tags: [api, 2d, primitive]
symbols: [circle]
seeAlso: [api/sketch, api/ellipse, api/arc]
---

# circle

Imported from `fluidcad/core`.

```ts
circle(diameter?)                       // at cursor, default diameter 40
circle(center: Point2D, diameter?)
circle(targetPlane, diameter)
```

Returns `ExtrudableGeometry`. The argument is the **diameter** — not the
radius. With no `center`, the circle is drawn at the current cursor.

## Example

```fluid.js
import { circle, extrude, sketch } from "fluidcad/core";

sketch("xy", () => {
  circle(50);                 // at the origin/cursor
  circle([60, 0], 20);        // smaller circle offset to the right
});
extrude(10);
```

See [[api/ellipse]] for asymmetric diameters and [[api/arc]] for partial
circles.
