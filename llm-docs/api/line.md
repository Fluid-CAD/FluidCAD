---
id: api/line
title: line(end) / line(start, end)
summary: Straight 2D line on the active sketch plane. The single-argument form draws from the cursor to `end`.
tags: [api, 2d, primitive]
symbols: [line]
seeAlso: [api/sketch, api/connect, api/arc]
---

# line

```ts
line(end: Point2D)
line(start: Point2D, end: Point2D)
line(targetPlane, end)
```

Returns `Geometry`. The one-argument form draws from the cursor to `end`;
the cursor advances to `end` afterward.

For axis-aligned segments use `hLine` / `vLine`; for angle-relative
segments use `aLine`. Those keep your intent ("horizontal segment of
length 30") visible and let the solver resolve targets like
`hLine(targetCircle)`.

## Example

```fluid.js
sketch("xy", () => {
  line([0, 0], [40, 0]);
  line([40, 30]);             // continues from the previous cursor
  line([0, 30]);
  line([0, 0]);
});
extrude(5);
```

See [[api/connect]] for closing a path back to its start.
