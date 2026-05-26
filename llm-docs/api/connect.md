---
id: api/connect
title: connect(mode?)
summary: Bridges the open ends of the current sketch's edges into one closed wire. Pass `"arc"` to bridge with tangent arcs instead of straight segments.
tags: [api, 2d, primitive]
symbols: [connect]
seeAlso: [api/line, api/arc, api/sketch]
---

# connect

Imported from `fluidcad/core`.

```ts
connect(mode?: "line" | "arc")
```

Sweeps all previously drawn edges in the active sketch and stitches them
into a closed wire, inserting bridge segments (or tangent arcs in `"arc"`
mode) between consecutive endpoints — including the final closing bridge
back to the first edge.

Use `connect` for sketches built from a few discrete curves (e.g., an
open arc) that need to be closed into an extrudable face. For outlines
already built from contiguous `line` / `hLine` / `vLine` segments,
explicit closing segments are clearer than `connect`.

## Example

```fluid.js
import { arc, connect, extrude, sketch } from "fluidcad/core";

sketch("xy", () => {
  arc(30);            // half-circle starting at the cursor
  connect();          // close it into a half-disc face
});
extrude(5);
```

See [[api/arc]] for the curve being closed and [[api/line]] for the
explicit closing-segment alternative.
