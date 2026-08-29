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

```js
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

## Axes of a face's plane

Sketching on a face (`sketch(e.startFaces(), ...)`) derives a plane from
it. Its axes come from the face normal alone, never from how the face
happened to be built:

- **Y (up)** is world `+Z` projected onto the face — so a sketch on any
  non-horizontal face reads upright, whichever operation produced it.
- **X** is `Y x normal`, always horizontal.
- On a **horizontal** face (`normal` within ~26 degrees of `+Z`) there is no
  uphill direction, so `+Y` is used as the up reference instead.

The rule reproduces the six standard planes exactly: a face lying in the
XZ plane gets the same axes `sketch("xz", ...)` would have given it, and a
face pointing the other way gets `"-xz"`'s. Connectors on a face use the
same frame.

Use `plane(face, { rotateZ })` when you want a different in-plane
orientation.

## Reference geometry

- `plane(name | face, options)` — build a new plane offset/rotated from
  an existing one, or derived from a face.
- `axis(name | edge, options)` — same idea for axes.

These are the only things that need to know about coordinate systems
explicitly; everything else flows from the active sketch's plane.
