---
id: api/types/plane
title: Plane
summary: "A plane datum in the scene — what `plane()` returns."
tags: [api, type, interface]
symbols: [Plane, IPlane]
seeAlso: [api/plane, api/types/plane-like, api/types/scene-object]
---
# Plane

```ts
interface Plane extends SceneObject {
  getPlane(): Plane;
}
```

A plane datum in the scene — what `plane()` returns. `getPlane()` is the
one member every plane object shares; it is declared here (rather than
leaving the interface empty) so a plane is structurally distinct from a
bare `ISceneObject` and overloaded functions such as `mirror()` resolve
their `PlaneLike` forms instead of a 2D `line` form.

Extends [[api/types/scene-object]].

## Methods

### `getPlane()`

The resolved plane (origin, normal, x-direction) this datum stands for.

**Returns**: [[api/types/plane]].

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
