---
sidebar_position: 5
title: "Copying"
---

# Copying

`copy()` duplicates the **entire shape** in linear or circular arrangements. The original solid is cloned as-is — FluidCAD doesn't re-run any modeling operations, it just places copies of the finished shape at new positions.

## Linear copy

Duplicate a shape along one axis:

```js
import { circle, copy, extrude, sketch } from 'fluidcad/core';

sketch("xy", () => {
    circle([150, 150], 100)
})

extrude()

copy("linear", "x", {
    count: 4,
    offset: 150
})
```

Options:
- **`count`** — total number of instances (including the original)
- **`offset`** — spacing between each instance
- **`skip`** — indices to skip (0-based)

### Multi-axis linear copy

Copy along two axes at once:

```js
copy("linear", ["x", "y"], {
    count: 4,
    offset: 150,
    skip: [[2], [1, 3]]       // skip index 2 on X, indices 1 and 3 on Y
})
```

When using two axes, `count`, `offset`, and `skip` can each be arrays — one value per axis.

## Circular copy

Duplicate a shape around an axis:

```js
copy("circular", "z", {
    count: 4,
    angle: 180                // spread copies over 180°
})
```

Options:
- **`count`** — total number of instances (including the original)
- **`angle`** — total angle to spread across (default: 360)
- **`skip`** — indices to skip

## Example: bolt pattern

Create a base plate with a grid of holes:

```js
import { sketch, extrude, cut, copy } from 'fluidcad/core';
import { rect, circle, move } from 'fluidcad/core';

// Base plate
sketch("xy", () => {
    rect(200, 120).center()
})

const plate = extrude(10)

// One hole
sketch(plate.endFaces(), () => {
    move([-70, -40])
    circle(15)
})

cut()

// Duplicate the hole in a 4x3 grid
copy("linear", ["x", "y"], {
    count: [4, 3],
    offset: [46, 40]
})
```

:::info[Copy vs. Repeat]
`copy()` duplicates the finished shape. If you need to re-apply a modeling operation (like a cut or extrude) at multiple positions — so it interacts with the underlying solid at each location — use [`repeat()`](./patterns) instead.
:::
