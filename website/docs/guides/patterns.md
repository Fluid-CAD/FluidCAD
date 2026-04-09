---
sidebar_position: 6
title: "Patterns (Repeat)"
---

# Patterns (Repeat)

`repeat()` re-applies a **modeling feature** at multiple positions. Unlike [`copy()`](./copying), which duplicates the finished shape, `repeat()` re-runs the operation — so the feature interacts with the solid at each new location just as if you had written it there by hand.

## When to use repeat vs. copy

Think of it this way:

- **`copy()`** takes a snapshot of the shape and stamps it at new positions. The copies are independent clones of the finished geometry.
- **`repeat()`** takes a feature (like a cut or extrude) and re-applies it at new positions. Each repetition cuts into, extrudes from, or otherwise modifies the existing solid.

This distinction matters most with operations like `cut()`. If you cut a pocket and then `copy()` the result, you get clones of the entire solid (each with one pocket). If you cut a pocket and then `repeat()` the cut, you get one solid with multiple pockets.

```js
// ❌ copy() clones the whole shape — you get separate solids with one pocket each
cut(15)
copy("linear", "x", { count: 4, offset: 40 })

// ✅ repeat() re-applies the cut — you get one solid with 4 pockets
const c = cut(15)
repeat("linear", "x", { count: 4, offset: 40 }, c)
```

## Linear repeat

Repeat a feature along one or more axes:

```js
import { repeat } from 'fluidcad/core';

const c = cut(15)

repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
}, c)
```

The last argument is the feature to repeat — the return value from `extrude()`, `cut()`, `fillet()`, etc.

Options:
- **`count`** — number of repetitions per axis
- **`length`** — total span to distribute across (evenly spaced)
- **`offset`** — explicit spacing between repetitions (alternative to `length`)

Use `length` when you know the total distance and want even spacing. Use `offset` when you know the exact spacing you want.

## Circular repeat

Repeat a feature around an axis:

```js
repeat("circular", "z", {
    count: 6,
    angle: 360
}, e)
```

Options:
- **`count`** — number of repetitions
- **`angle`** — total angle to spread across (default: 360)

## Mirror repeat

Repeat a feature mirrored across a plane:

```js
const e = extrude(20)
repeat("mirror", "front", e)   // mirror the extrude across the front plane
```

This re-applies the feature on the other side of the plane — useful for building symmetric models where you only need to define one half.

## Example: ice cube tray pockets

Cut one pocket, then repeat it across a grid:

```js
import { sketch, extrude, cut, repeat, move, rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(300, 104).center()
})

const tray = extrude(50)

// One pocket
sketch(tray.endFaces(), () => {
    move([-143, -45])
    rect(30, 40)
})

const pocket = cut(30).draft(-10)

// Repeat the pocket in a 7x2 grid
repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
}, pocket)
```

Each repetition cuts into the same tray, producing a single solid with 14 pockets — exactly what you'd want for a mold or tray design.
