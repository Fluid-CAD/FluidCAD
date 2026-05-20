---
id: api/slot
title: slot(distance, radius)
summary: Stadium-shaped slot — a rectangle with semicircular end caps — defined by length and end-cap radius.
tags: [api, 2d, primitive]
symbols: [slot]
seeAlso: [api/rect, api/sketch]
---

# slot

```ts
slot(distance, radius)
slot(start: Point2D, distance, radius)
slot(geometry, radius, deleteSource?)        // wrap around an existing edge
slot(targetPlane, distance, radius)
slot(targetPlane, geometry, radius)
```

Returns `Slot` with `.centered(value?)` and `.rotate(angle)`.

## Example

```fluid.js
sketch("xy", () => slot(80, 10).centered());
extrude(8);
```

Reach for slot whenever you'd otherwise hand-compute the end-cap arc
positions of a straight pocket.

See [[api/rect]] for the sharp-cornered variant.
