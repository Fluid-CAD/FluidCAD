---
id: api/types/bridge
title: Bridge
summary: "A smooth curve between two curve ends: `bridge(from, to)`."
tags: [api, type, interface]
symbols: [Bridge, IBridge]
seeAlso: [api/bridge, api/sweep, api/loft, api/types/curve-result]
---
# Bridge

```ts
interface Bridge extends CurveResult {
  continuity(value: "g0" | "g1" | "g2"): this;
  startMagnitude(value: NumberParam): this;
  endMagnitude(value: NumberParam): this;
}
```

A smooth curve between two curve ends: `bridge(from, to)`. One wire of
one edge that leaves `from` the way its curve was heading and arrives at
`to` heading into its curve. The options are chained methods, in any
order.

Extends [[api/types/curve-result]].

## Methods

### `continuity()`

How the bridge meets each end: `'g0'` position only (a straight line
between the two points), `'g1'` tangent (the default), `'g2'`
curvature. Applied at both ends; an end that is a plain point only
ever matches position.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `"g0"` \| `"g1"` \| `"g2"` | `'g0'`, `'g1'` or `'g2'`. |

### `startMagnitude()`

How far the bridge keeps going straight before it turns, at its start:
1 by default; larger is fuller, smaller is tighter. Measured against
the distance between the two ends, so a magnitude gives the same shape
at any scale. Must be greater than zero.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | A number greater than zero. |

### `endMagnitude()`

The same at its end: how far the bridge runs straight into the `to`
curve. 1 by default. Must be greater than zero.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | A number greater than zero. |

## Inherited

From [[api/types/curve-result]]: `edges()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
