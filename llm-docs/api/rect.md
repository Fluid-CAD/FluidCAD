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
r.edge('top'); r.edge('bottom'); r.edge('left'); r.edge('right');
r.topLeft(); r.topRight(); r.bottomLeft(); r.bottomRight();
r.edge('corner-arc', 2);  // corner arcs exist only when a radius is applied;
                          // indices follow the radius-arg order bl/br/tr/tl
```

## Example

```fluid.js
import { extrude, rect, sketch } from "fluidcad/core";

sketch("xy", () => rect(100, 60).centered().radius(8));
extrude(15);
```

See [[api/sketch]] for the sketch context and [[api/extrude]] for the
typical follow-up operation.
