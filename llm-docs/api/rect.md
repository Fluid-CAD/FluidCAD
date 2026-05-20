---
id: api/rect
title: rect(width, height?)
summary: Draws an axis-aligned rectangle on the active sketch plane. Optional corner radii via `.radius(...)` and edge/vertex accessors for downstream selections.
tags: [api, 2d, primitive]
symbols: [rect]
seeAlso: [api/sketch, api/extrude]
---

# rect

Imported from `fluidcad/core`.

```ts
rect(width, height?)
rect(start: Point2D, width, height?)
rect(targetPlane, width, height)
```

Draws a rectangle. `height` defaults to `width` (square). Returns `Rect`.

## Chain methods

- `.centered(value?)` — `true` (default) to center on both axes;
  `"horizontal"` or `"vertical"` to center on one axis only.
- `.radius(...r)` — corner radii. `radius(5)` rounds all four. The
  four-arg form is `[bottomLeft, bottomRight, topRight, topLeft]`.

## Direct accessors

```js
const r = rect(100, 60);
r.topEdge(); r.bottomEdge(); r.leftEdge(); r.rightEdge();
r.topLeft(); r.topRight(); r.bottomLeft(); r.bottomRight();
r.topLeftArcEdge();   // only present when a corner radius is applied
```

## Example

```fluid.js
import { extrude, rect, sketch } from "fluidcad/core";

sketch("xy", () => rect(100, 60).centered().radius(8));
extrude(15);
```

See [[api/sketch]] for the sketch context and [[api/extrude]] for the
typical follow-up operation.
