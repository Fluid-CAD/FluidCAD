---
id: api/types/ellipse
title: Ellipse
summary: "An ellipse statement — a solver entity like a circle: center, rotation and both semi-radii solve."
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

An ellipse statement — a solver entity like a circle: center, rotation
and both semi-radii solve. The statement itself is a constraint target:
`radius(el, v, 'x' | 'y')` dimensions a semi-radius,
`horizontal(el)`/`vertical(el)` orient its RX axis, `concentric(el, c)`
shares its center, `tangent(el, l)` touches a line, circle, arc or
another ellipse, `coincident(p, el)` puts a point on it, `equal(e1, e2)`
matches shapes.

Extends [[api/types/extrudable-geometry]].

## Methods

### `center()`

Returns a lazy-evaluated vertex at the ellipse's center — a
constraint target like a circle's `.center()`.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`, `reusable()`
