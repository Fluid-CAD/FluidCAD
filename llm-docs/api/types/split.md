---
id: api/types/split
title: Split
summary: "A split — what `split()` returns."
tags: [api, type, interface]
symbols: [Split, ISplit]
seeAlso: [api/split, api/plane, api/types/scene-object]
---
# Split

```ts
interface Split extends SceneObject {
  getPlane(): Plane;
}
```

A split — what `split()` returns. The pieces it made of the solids the
plane crossed are its shapes; a feature naming the split as a target
reads all of them.

Extends [[api/types/scene-object]].

## Methods

### `getPlane()`

The cut plane as built (origin, normal, x-direction); null when the cut is a sketched curve's sheet, which has no plane.

**Returns**: [[api/types/plane]].

## Inherited

From [[api/types/scene-object]]: `name()`
