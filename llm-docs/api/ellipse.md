---
id: api/ellipse
title: ellipse(center, rx, ry)
summary: Draws an ellipse at an explicit center using semi-radii (half-widths) along the sketch plane's X and Y axes.
tags: [api, 2d, primitive]
symbols: [ellipse]
seeAlso: [api/circle, api/sketch]
---

# ellipse

Imported from `fluidcad/core`.

```ts
ellipse(center: Point2D, rx, ry)
```

`rx` and `ry` are **semi-radii** — half-widths along the plane's X and Y
axes. (Compare `circle`, which takes a diameter.) The center is
required and explicit. Returns `ExtrudableGeometry` — a fixed-shape
entity: it renders and extrudes, but is not yet a constrainable solver
entity.

## Example

```fluid.js
import { ellipse, extrude, sketch } from "fluidcad/core";

sketch("xy", () => ellipse([0, 0], 60, 30));
extrude(8);
```

See [[api/circle]] for the symmetric case.
