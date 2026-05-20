---
id: concepts/coordinate-system
title: Coordinate systems and sketch axes
summary: World axes are x, y, z. Standard planes are xy, xz, yz. Inside a sketch, x and y refer to the sketch plane's local frame, not world axes.
tags: [concept, geometry]
seeAlso: [api/sketch]
---

# Coordinate systems

## World

- Right-handed: `+X` right, `+Y` away, `+Z` up.
- Axes: `"x"`, `"y"`, `"z"`.
- Standard planes: `"xy"`, `"xz"`, `"yz"`. Aliases like `"front"` are
  also recognized — `"front"` is the XZ plane.

## Inside a sketch

Inside a `sketch(...)` callback, **`"x"` and `"y"` mean the sketch
plane's local axes**, not world axes. This is what lets the same
sketching code work on any plane.

For an axis interpreted in the sketch's local frame **from outside the
sketch context**, use `local("x" | "y" | "z")`:

```fluid.js
sketch(tiltedPlane, () => {
    // inside: "x" already means the sketch plane's X
    mirror("x");
});

// outside but still want the sketch-local axis:
mirror(local("x"));
```

## Reference geometry

- `plane(name | face, options)` — build a new plane offset/rotated from
  an existing one, or derived from a face.
- `axis(name | edge, options)` — same idea for axes.

These are the only things that need to know about coordinate systems
explicitly; everything else flows from the active sketch's plane.
