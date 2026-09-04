---
id: api/types/axis
title: Axis
summary: "An axis datum in the scene — what `axis()` and `local()` return."
tags: [api, type, interface]
symbols: [Axis, IAxis]
seeAlso: [api/axis, api/types/axis-like, api/types/scene-object]
---
# Axis

```ts
interface Axis extends SceneObject {
  getAxis(): Axis;
}
```

An axis datum in the scene — what `axis()` and `local()` return. `getAxis()`
plays the same structural role here as `getPlane()` does on `IPlane`.

Extends [[api/types/scene-object]].

## Methods

### `getAxis()`

The resolved axis (origin, direction) this datum stands for.

**Returns**: [[api/types/axis]].

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
