---
id: api/types/distance
title: Distance
summary: "A distance dimension statement in a constraint-mode sketch."
tags: [api, type, interface]
symbols: [Distance, IDistance]
seeAlso: [api/constraints, api/types/scene-object]
---
# Distance

```ts
interface Distance extends SceneObject {
  max(): this;
  min(): this;
}
```

A distance dimension statement in a constraint-mode sketch.

Extends [[api/types/scene-object]].

## Methods

### `max()`

Measures to the FAR side of any circle/arc in the pair (the
SolidWorks/Onshape arc-condition "max"): point–circle and
line–circle measure `center distance + radius`, circle–circle
measures between the far circumferences. Requires a circle or arc
entity target. For a center distance, dimension the accessor
instead: `distance(l, a.center(), v)`.

### `min()`

Measures to the NEAR side of the circumference — the default; an
explicit `.min()` only documents intent.

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
