---
id: api/types/section
title: Section
summary: "A saved section view — what `section()` returns."
tags: [api, type, interface]
symbols: [Section, ISection]
seeAlso: [api/types/scene-object]
---
# Section

```ts
interface Section extends SceneObject {
  getPlane(): Plane;
}
```

A saved section view — what `section()` returns. It builds nothing and
has no timeline row; the viewer's section menu lists it by name.

Extends [[api/types/scene-object]].

## Methods

### `getPlane()`

The cut plane before its offset, as built (origin, normal, x-direction).

**Returns**: [[api/types/plane]].

## Inherited

From [[api/types/scene-object]]: `name()`
