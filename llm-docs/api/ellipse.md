---
id: api/ellipse
title: ellipse(rx, ry)
summary: Draws an ellipse using semi-radii (half-widths) along the sketch plane's X and Y axes.
tags: [api, 2d, primitive]
symbols: [ellipse]
seeAlso: [api/circle, api/sketch]
---

# ellipse

Imported from `fluidcad/core`.

```ts
ellipse(rx, ry)
ellipse(center, rx, ry)
ellipse(targetPlane, rx, ry)
ellipse(targetPlane, center, rx, ry)
```

`rx` and `ry` are **semi-radii** — half-widths along the plane's X and Y
axes. (Compare `circle`, which takes a diameter.) Returns
`ExtrudableGeometry`.

## Example

```fluid.js
import { ellipse, extrude, sketch } from "fluidcad/core";

sketch("xy", () => ellipse(60, 30));
extrude(8);
```

See [[api/circle]] for the symmetric case.
