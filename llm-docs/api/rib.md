---
id: api/rib
title: rib(thickness, spine?)
summary: Builds a rib from an open spine sketch. Extends in the sketch plane normal until it meets surrounding solids.
tags: [api, 3d, solid]
symbols: [rib]
seeAlso: [api/sketch, api/extrude]
---

# rib

Imported from `fluidcad/core`.

```ts
rib(thickness)                          // uses last sketch as spine
rib(thickness, spine: SceneObject)
```

Returns `Rib` (extends `BooleanOperation`). Sign of `thickness` chooses
direction: positive forward, negative backward. Chain methods:

- `.parallel()` — extrude parallel to the sketch plane instead of the
  normal direction.
- `.extend()` — extend the rib ends so they blend with surrounding walls.

Plus the standard face/edge accessors (`startFaces`, `endFaces`,
`sideFaces`, etc.).

## Example

```fluid.js
import { extrude, line, rect, rib, sketch } from "fluidcad/core";

sketch("xy", () => rect(120, 80).centered());
extrude(40);
sketch("xz", () => line([-40, 5], [40, 5]));
rib(3).extend();
```

See [[api/extrude]] for the base solid the rib connects into.
