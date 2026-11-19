---
id: api/types/dimension
title: Dimension
summary: "A dimension statement in a constraint-mode sketch — `distance()`, `radius()`, `diameter()`, `angle()` or `offsetFrom()`."
tags: [api, type, interface]
symbols: [Dimension, IDimension]
seeAlso: [api/constraints, api/types/scene-object]
---
# Dimension

```ts
interface Dimension extends SceneObject {
  labelAt(u: NumberParam, v: NumberParam): this;
}
```

A dimension statement in a constraint-mode sketch — `distance()`,
`radius()`, `diameter()`, `angle()` or `offsetFrom()`.

Extends [[api/types/scene-object]].

## Methods

### `labelAt()`

Places the dimension's value where it reads best. This is what the
sketcher writes when a dimension is placed as it is drawn, or dragged
afterwards; it only moves the annotation and never changes the
geometry. Without it the value is laid out automatically.

The two numbers are sketch units in the dimension's own frame, so the
placement follows the geometry when it moves or turns:

- `distance()` and `offsetFrom()`: `u` slides the value along the
  dimension line from its middle, `v` is how far the dimension line
  stands off the span it measures (either side).
- `radius()` and `diameter()`: the value sits `(u, v)` from the center
  along the sketch's x and y; the leader turns to pass through it. An
  ellipse's `radius(el, r, 'x')` reads like a distance instead: along
  and off its semi-axis.
- `angle()`: the value sits `u` out along the bisector of the measured
  angle from the corner and `v` to its side; the arc is drawn through it.

| Parameter | Type | Description |
| --- | --- | --- |
| `u` | `NumberParam` | Position along the dimension's frame, in sketch units |
| `v` | `NumberParam` | Position across the dimension's frame, in sketch units |

## Inherited

From [[api/types/scene-object]]: `name()`
