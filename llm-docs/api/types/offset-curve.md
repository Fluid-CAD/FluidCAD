---
id: api/types/offset-curve
title: OffsetCurve
summary: "A curve beside edges at a constant distance, lying on faces: `offset(distance, edges, { on: faces })` written outside a sketch."
tags: [api, type, interface]
symbols: [OffsetCurve, IOffsetCurve]
seeAlso: [api/offset, api/sweep, api/types/curve-result]
---
# OffsetCurve

```ts
interface OffsetCurve extends CurveResult {
  // No own methods — see Inherited below.
}
```

A curve beside edges at a constant distance, lying on faces:
`offset(distance, edges, { on: faces })` written outside a sketch. One
wire per chain of the edges, each running the same way as its source, in
source order. It has no options beyond its arguments.

Extends [[api/types/curve-result]].

## Inherited

From [[api/types/curve-result]]: `edges()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
