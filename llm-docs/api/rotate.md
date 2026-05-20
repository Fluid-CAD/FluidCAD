---
id: api/rotate
title: rotate(axis, angle, ...targets?)
summary: Rotates one or more objects around an axis (3D) or in the sketch plane (2D). Degrees, not radians.
tags: [api, 3d, 2d, transform]
symbols: [rotate]
seeAlso: [api/translate, api/mirror]
---

# rotate

Imported from `fluidcad/core`.

```ts
// 2D — inside a sketch, around the plane's Z (i.e., the sketch normal)
rotate(angle, ...targets)
rotate(angle, copy: boolean, ...targets)

// 3D — around a world or custom axis
rotate(axis: AxisLike, angle, ...targets)
rotate(axis, angle, copy: boolean, ...targets)
```

Angles are degrees. `AxisLike` is `"x"` / `"y"` / `"z"`, a direction
vector, or an `{ point?, direction }` record. `copy: true` clones the
source rather than rotating it in place.

## Example

```fluid.js
import { cylinder, rotate } from "fluidcad/core";

const c = cylinder(8, 40);
rotate("x", 90, c);                              // lay the cylinder on its side
```

See [[api/translate]] for moves and [[api/mirror]] for reflections.
