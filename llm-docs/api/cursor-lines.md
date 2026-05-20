---
id: api/cursor-lines
title: hLine / vLine / aLine
summary: Axis-aligned and angle-relative line segments that start from the current cursor — the idiomatic substitute for hand-computed endpoint coordinates.
tags: [api, 2d, cursor, primitive]
symbols: [hLine, vLine, aLine]
seeAlso: [api/line, api/cursor-move, api/sketch]
---

# hLine / vLine / aLine

```ts
hLine(distance)
hLine(target: SceneObject)              // ends at the nearest intersection with target
hLine(start, distance)
hLine(targetPlane, distance)

vLine(distance | target | start+distance | targetPlane+distance)

aLine(angle, length)                    // angle in degrees, length along that angle
aLine(angle, target)
aLine(targetPlane, angle, length)
```

All three return cursor-aware geometries (`HLine`, `VLine`, `ALine`),
each with `.centered(value?)` to center the line on the cursor instead
of starting from it.

Prefer these over `line([x + d, y])`-style absolute coordinates: the
intent ("a 40-unit horizontal segment") stays legible, and `target`
forms let the solver find the intersection for you.

## Example

```fluid.js
sketch("xy", () => {
  hLine(60);                 // → (60, 0)
  vLine(40);                 // → (60, 40)
  hLine(-60);                // → (0, 40)
  vLine(-40);                // → (0, 0)  closes the wire
});
extrude(5);
```

See [[api/cursor-move]] for moving the cursor without drawing, and
[[api/line]] for explicit-endpoint segments.
