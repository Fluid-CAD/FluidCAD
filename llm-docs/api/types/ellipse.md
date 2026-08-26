---
id: api/types/ellipse
title: Ellipse
summary: "An ellipse statement."
tags: [api, type, interface]
symbols: [Ellipse, IEllipse]
seeAlso: [api/types/extrudable-geometry]
---
# Ellipse

```ts
interface Ellipse extends ExtrudableGeometry {
  center(): Vertex;
}
```

An ellipse statement. Inside a sketch its center is a solver point
entity — constraints target `.center()` and the solve positions the
ellipse; the radii stay fixed literals.

Extends [[api/types/extrudable-geometry]].

## Methods

### `center()`

Returns a lazy-evaluated vertex at the ellipse's center.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
