---
id: concepts/coordinate-system
title: Coordinate systems and sketch axes
summary: World axes are x, y, z. Standard planes are xy, xz, yz. "x"/"y"/"z" always mean world axes — even inside a sketch. Use local("x" | "y" | "z") for the sketch plane's local axes.
tags: [concept, geometry]
seeAlso: [api/sketch]
---

# Coordinate systems

## World

- Right-handed: `+X` right, `+Y` away, `+Z` up.
- Axes: `"x"`, `"y"`, `"z"`.
- Standard planes: `"xy"`, `"xz"`, `"yz"`. Aliases like `"front"` are
  also recognized — `"front"` is the XZ plane.

## Sketch-local axes

`"x"`, `"y"`, `"z"` **always refer to world axes**, including inside a
`sketch(...)` callback. To refer to the active sketch plane's local
axes, use `local("x" | "y" | "z")`:

```fluid.js
sketch(tiltedPlane, () => {
    // "x" here is still the WORLD x axis
    mirror("x");

    // use local(...) for the sketch plane's local X
    mirror(local("x"));
});

// local(...) also works outside the sketch callback,
// resolved against the currently active sketch plane:
mirror(local("x"));
```

## Reference geometry

- `plane(name | face, options)` — build a new plane offset/rotated from
  an existing one, or derived from a face.
- `axis(name | edge, options)` — same idea for axes.

These are the only things that need to know about coordinate systems
explicitly; everything else flows from the active sketch's plane.
