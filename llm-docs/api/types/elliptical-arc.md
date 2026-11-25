---
id: api/types/elliptical-arc
title: EllipticalArc
summary: "An elliptical arc statement: an open piece of an ellipse."
tags: [api, type, interface]
symbols: [EllipticalArc, IEllipticalArc]
seeAlso: [api/types/geometry]
---
# EllipticalArc

```ts
interface EllipticalArc extends Geometry {
  cw(): this;
  ccw(): this;
  center(): Vertex;
}
```

An elliptical arc statement: an open piece of an ellipse. It is a solver
entity that is an ellipse and an arc at once. The statement itself takes
what an ellipse takes: `radius(ea, v, 'x' | 'y')` dimensions a
semi-radius, `horizontal(ea)`/`vertical(ea)` orient its RX axis,
`concentric(ea, c)` shares its center, `tangent(ea, l)` touches a line,
circle, arc, ellipse or another elliptical arc, `coincident(p, ea)` puts
a point on its ellipse, `equal(ea, e)` matches shapes. Its `start()`,
`end()` and `center()` are points like an arc's.

Extends [[api/types/geometry]].

## Methods

### `cw()`

Sweeps the arc clockwise from start to end (display and topology only:
the solver has no sweep parameter).

### `ccw()`

Sweeps the arc counter-clockwise from start to end (the default).

### `center()`

Returns a lazy-evaluated vertex at the center of the arc's ellipse.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
