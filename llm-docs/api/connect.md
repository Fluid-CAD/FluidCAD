---
id: api/connect
title: connect(mode?)
summary: Closes the current polyline with one bridge edge from the last segment's end back to the first segment's start. Pass `"arc"` to bridge with a tangent arc instead of a straight segment.
tags: [api, 2d, primitive]
symbols: [connect]
seeAlso: [api/line, api/arc, api/sketch]
---

# connect

Imported from `fluidcad/core`.

```ts
connect(mode?: "line" | "arc")
```

Emits a single closing edge from the end of the last drawn segment back to
the start of the current polyline's first segment. The first segment is
found by walking the previous statements backwards to the last one that
does not use relative positioning:

- the segment right after an absolute `move([x, y])`, or
- an explicit-start segment (`line([a], [b])` forms, the two-point `arc`),

whichever comes last. Chained statements (`tLine`, `tArc`, `hLine`,
relative moves like `hMove`, ...) derive their position from the cursor
and are walked past; closed shapes (`circle`, `rect`, ...) are skipped.
If the whole sketch is one chain, the polyline starts at the sketch's
start point. Earlier geometry is never consumed or re-emitted, and a
polyline that already ends on its start point makes `connect()` a no-op.

In `"arc"` mode the bridge is an arc tangent to the last segment's end
direction; it falls back to a straight line when that tangent is collinear
with the bridge.

## Example

```fluid.js
import { arc, connect, extrude, sketch } from "fluidcad/core";

sketch("xy", () => {
  arc(30);            // half-circle centered on the cursor
  connect();          // close it into a half-disc face
});
extrude(5);
```

See [[api/arc]] for the curve being closed and [[api/line]] for the
explicit closing-segment alternative.
