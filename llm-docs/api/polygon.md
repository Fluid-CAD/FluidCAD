---
id: api/polygon
title: polygon(n, diameter, mode?)
summary: Regular n-sided polygon sized by the inscribed or circumscribed diameter — no manual `[r*cos, r*sin]` math.
tags: [api, 2d, primitive]
symbols: [polygon]
seeAlso: [api/circle, api/sketch]
---

# polygon

Imported from `fluidcad/core`.

```ts
polygon(numberOfSides, diameter, mode?)
polygon(center, numberOfSides, diameter, mode?)
polygon(targetPlane, numberOfSides, diameter)
polygon(targetPlane, numberOfSides, diameter, mode)
```

Regular polygon. `mode` is `"inscribed"` (default — corners sit on the
diameter circle) or `"circumscribed"` (edge midpoints sit on the diameter
circle). Returns `Polygon` with `.getEdge(i)` / `.getVertex(i)` (0-based).

## Example

```fluid.js
import { extrude, polygon, sketch } from "fluidcad/core";

sketch("xy", () => polygon(6, 60));   // hexagon, 60 diameter
extrude(10);
```

Prefer this over computing corner coordinates with trig — the kernel
handles inscribed/circumscribed sizing exactly.

See [[api/circle]] for the matching curve primitive.
