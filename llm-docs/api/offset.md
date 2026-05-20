---
id: api/offset
title: offset(distance?, removeOriginal?)
summary: Offsets the current sketch wire outward (positive) or inward (negative). Use `.close()` to cap an open offset.
tags: [api, 2d, modifier]
symbols: [offset]
seeAlso: [api/sketch, api/extrude]
---

# offset

Imported from `fluidcad/core`.

```ts
offset(distance?, removeOriginal?)
offset(targetPlane, distance, removeOriginal, ...sourceGeometries)
```

Returns `Offset`. Default distance is `1`. Chain `.close()` to cap an
open offset into a closed wire ready for extrusion. Positive distances
push outward (relative to wire winding); negative pushes inward.

## Example

```fluid.js
import { extrude, offset, rect, sketch } from "fluidcad/core";

sketch("xy", () => {
  rect(60, 40).centered();
  offset(5);                  // 5mm outward offset
});
extrude(4);
```

See [[api/sketch]] for the parent context and [[api/extrude]] for the
typical follow-up.
