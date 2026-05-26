---
id: api/local
title: local("x" | "y" | "z")
summary: Returns an axis interpreted against the active sketch's plane, not the world. Use whenever you mean "this sketch's X axis" rather than world X.
tags: [api, reference, geometry, 2d]
symbols: [local]
seeAlso: [api/axis, api/plane, concepts/coordinate-system]
---

# local

Imported from `fluidcad/core`.

```ts
local("x" | "y" | "z")
```

`"x"` / `"y"` / `"z"` always refer to **world axes**, even inside a
sketch on a tilted plane. `local("x")` resolves to the active sketch's
local X instead. Reach for it whenever you'd otherwise write
`mirror("x")` and find it mirrors across the world axis rather than the
sketch axis.

## Example

```fluid.js
import { extrude, local, mirror, plane, rect, sketch } from "fluidcad/core";

const tilted = plane("xy", { rotateX: 30 });
sketch(tilted, () => {
  rect(40, 20).centered();
  mirror(local("x"));        // mirror the rect across the sketch's local X
});
extrude(4);
```

See [[concepts/coordinate-system]] for the full world-vs-local rule, and
[[api/axis]] for non-local axes.
