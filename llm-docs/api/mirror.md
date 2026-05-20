---
id: api/mirror
title: mirror(plane | axis | line, ...targets?)
summary: Reflects sketch geometry across a line/axis or 3D solids across a plane. World-axis strings stay world-axis even inside a sketch — use `local("x")` for the sketch's local X.
tags: [api, 2d, 3d, transform]
symbols: [mirror]
seeAlso: [api/translate, api/rotate, concepts/coordinate-system]
---

# mirror

```ts
// 2D (inside a sketch)
mirror(line: SceneObject)
mirror(axis: AxisLike)
mirror(line, ...geometries)
mirror(axis, ...geometries)

// 3D
mirror(plane: PlaneLike, ...objects)
```

Inside a sketch, reflects geometry across a line or axis. Outside a
sketch, reflects solids across a plane. The 3D form returns `Mirror`
(extends `BooleanOperation`) and supports `.exclude(...objects)` to
skip specific objects.

**`"x"` is the world X axis, even inside a sketch.** To mirror across
the sketch plane's local X, use `mirror(local("x"))`. See
[[concepts/coordinate-system]] for the full convention.

## Example

```fluid.js
sketch("xy", () => rect(40, 30).centered());
const block = extrude(20).new();
mirror("yz", block);                             // mirror across the YZ plane
```

See [[api/translate]] / [[api/rotate]] for non-reflective transforms.
