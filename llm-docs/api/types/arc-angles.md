---
id: api/types/arc-angles
title: ArcAngles
summary: "The ArcAngles type. Extends ExtrudableGeometry; adds 1 method."
tags: [api, type, interface]
symbols: [ArcAngles, IArcAngles]
seeAlso: [api/arc, api/types/extrudable-geometry]
---
# ArcAngles

```ts
interface ArcAngles extends ExtrudableGeometry {
  centered(): this;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `centered()`

Centers the arc symmetrically around the start angle.

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
