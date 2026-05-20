---
id: api/primitive-solids
title: sphere / cylinder
summary: Sketch-free primitive solids. Both return Transformable, so translate/rotate/mirror chain directly off the result.
tags: [api, 3d, solid, primitive]
symbols: [sphere, cylinder]
seeAlso: [api/extrude, api/revolve]
---

# sphere / cylinder

```ts
sphere(radius)
sphere(radius, angle)                  // partial sphere (degrees)

cylinder(radius, height)
```

Both return `Transformable`, so you can chain `.translate()`, `.rotate()`,
or `.mirror()` directly on the result instead of wrapping in a separate
transform call.

These primitives don't need a sketch — reach for them when you want a
ball-bearing, dowel, or shaft and the parametric sketch+revolve dance
would be ceremony.

## Example

```fluid.js
sphere(25).translate(0, 0, 100);
cylinder(10, 50).rotate("x", 90);
```

See [[api/revolve]] for fully custom solids of revolution and
[[api/extrude]] for the sketch-driven equivalent.
