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
// 2D — inside a sketch, around an explicit center point in sketch coordinates
rotate(angle, center: Point2D, ...targets)
rotate(angle, center, copy: boolean, ...targets)

// 3D — around a world or custom axis
rotate(axis: AxisLike, angle, ...targets)
rotate(axis, angle, copy: boolean, ...targets)
```

Angles are degrees. `AxisLike` is `"x"` / `"y"` / `"z"`, a direction
vector, or an `{ point?, direction }` record. `copy: true` clones the
source rather than rotating it in place. The 2D form requires the
explicit `center` — there is no implicit rotation point in a constraint
sketch.

## 2D example

```fluid.js
import { circle, extrude, rotate, sketch } from "fluidcad/core";

sketch("xy", () => {
  const c = circle([40, 0], 16);
  rotate(120, [0, 0], true, c);      // copy rotated 120° about the origin
});
extrude(6);
```

## Example

```fluid.js
import { cylinder, rotate } from "fluidcad/core";

const c = cylinder(8, 40);
rotate("x", 90, c);                              // lay the cylinder on its side
```

See [[api/translate]] for moves and [[api/mirror]] for reflections.
