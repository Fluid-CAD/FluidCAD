---
id: api/plane
title: plane(reference, options?)
summary: Builds a reference plane from a standard name, an existing plane, a face, or the midpoint between two planes. Optional offset/rotation parametrize it.
tags: [api, reference, geometry]
symbols: [plane]
seeAlso: [api/axis, api/local, api/sketch]
---

# plane

```ts
plane(plane: PlaneLike, options: PlaneTransformOptions)
plane(plane: PlaneLike, offset: number)
plane(selection: SceneObject)                       // from a face
plane(selection: SceneObject, options)
plane(selection: SceneObject, offset)
plane(plane: Plane, options)                        // transform an existing plane
plane(p1: PlaneLike, p2: PlaneLike, options?)       // midplane between two planes
plane(p1: Plane, p2: Plane, options?)
```

`PlaneTransformOptions`:

- `offset: number` — translate along the normal.
- `rotateX`, `rotateY`, `rotateZ` — degrees.

## Example

```fluid.js
sketch("xy", () => rect(100, 60).centered());
extrude(20);

const top = plane("xy", 80);                        // XY shifted up 80
sketch(top, () => circle(20));
extrude(10);
```

See [[api/axis]] for the axis counterpart and [[api/local]] for the
sketch-relative axes.
