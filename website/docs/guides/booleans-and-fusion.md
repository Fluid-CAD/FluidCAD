---
sidebar_position: 7
title: "Booleans and Fusion"
---

# Booleans and Fusion

FluidCAD automatically merges (fuses) solids that touch. This guide explains how auto-fusion works and how to use explicit boolean operations when you need more control.

## Auto-fusion

By default, when you extrude a sketch and the result touches an existing solid, they merge into one:

```js
sketch("xy", () => {
    rect(60, 60).center()
})

extrude(30)                    // creates a box

sketch("xy", () => {
    circle([0, 0], 40)
})

extrude(50)                    // this cylinder auto-fuses with the box
```

The result is a single solid — the box with a cylinder sticking out of the top.

## Creating separate solids

Use `.new()` to prevent auto-fusion:

```js
sketch("xy", () => {
    rect(60, 60).center()
})

const box = extrude(30)

sketch("xy", () => {
    circle([80, 0], 40)
})

const cyl = extrude(30).new()  // separate solid, no fusion
```

## Explicit boolean operations

### Fuse (union)

Merge two or more solids into one:

```js
import { fuse } from 'fluidcad/core';

fuse(solid1, solid2)
```

### Subtract (difference)

Remove one solid from another:

```js
import { subtract } from 'fluidcad/core';

subtract(solidToKeep, solidToRemove)
```

### Common (intersection)

Keep only the volume where two solids overlap:

```js
import { common } from 'fluidcad/core';

common(solid1, solid2)
```

## When to use what

| Scenario | Approach |
|----------|----------|
| Adding a boss to an existing solid | Just extrude — auto-fusion handles it |
| Creating a hole | `sketch` on a face + `cut()` |
| Merging two separate objects | `fuse(a, b)` |
| Subtracting a shape from another | `subtract(keep, remove)` |
| Keeping only the overlap | `common(a, b)` |
| Building multiple independent parts | Use `.new()` or `part()` |
