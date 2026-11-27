---
id: api/types/intersection-curve
title: IntersectionCurve
summary: "The curve where two sets of faces meet: `intersect(first, second)` written outside a sketch."
tags: [api, type, interface]
symbols: [IntersectionCurve, IIntersectionCurve]
seeAlso: [api/types/curve-result]
---
# IntersectionCurve

```ts
interface IntersectionCurve extends CurveResult {
  // No own methods — see Inherited below.
}
```

The curve where two sets of faces meet: `intersect(first, second)`
written outside a sketch. One wire per connected chain of intersection
edges; `edges()` lists them curve after curve, each in the order it runs.

Extends [[api/types/curve-result]].

## Inherited

From [[api/types/curve-result]]: `edges()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
