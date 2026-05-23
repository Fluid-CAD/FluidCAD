---
id: api/cursor-move
title: move / hMove / vMove / rMove / pMove / center / back
summary: Cursor positioning primitives. They move the active sketch's cursor (and tangent, for rMove) without drawing geometry.
tags: [api, 2d, cursor]
symbols: [move, hMove, vMove, rMove, pMove, center]
seeAlso: [api/cursor-lines, api/sketch]
---

# Cursor movement

Imported from `fluidcad/core`.

```ts
move()                                  // jump back to the sketch plane origin
move(to: Point2D)                       // absolute move

hMove(distance)
hMove(target: SceneObject)              // move horizontally until hitting target

vMove(distance)
vMove(target)

rMove(angle)                            // rotate the tangent by `angle` (degrees)
rMove(angle, pivot: Point2D)

pMove(radius, angle)                    // polar move relative to current tangent
pMove(target, angle)

center()                                // jump to plane origin (alias for move() with no args)

back()                                  // revert one cursor change
back(count)                             // revert `count` cursor changes
```

These never produce edges — they reposition the cursor (and, for
`rMove`, the tangent) so the next drawing call lands where you want.
Reach for them instead of computing absolute coordinates by hand.

## Example

```fluid.js
import { extrude, hLine, sketch, vLine, vMove } from "fluidcad/core";

sketch("xy", () => {
  // Two L-shaped pieces sharing a sketch — vMove repositions without drawing.
  hLine(40);
  vLine(10);
  hLine(-40);
  vLine(-10);

  vMove(30);                 // jump up — no edge drawn
  hLine(20);
  vLine(10);
  hLine(-20);
  vLine(-10);
});
extrude(4);
```

See [[api/cursor-lines]] for the drawing counterparts.
