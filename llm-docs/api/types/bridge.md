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
  continuity(start: "g0" | "g1" | "g2", end?: "g0" | "g1" | "g2"): this;
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

How the bridge meets its ends: `'g0'` position only, `'g1'` tangent
(the default), `'g2'` curvature. One value sets both ends; two set the
start and the end — `.continuity('g2', 'g0')`. An end that is a plain
point only ever matches position, whatever its value; `'g0'` at both
ends is a straight line between the two points.

The main use of two values: a solid's corner is written as the end of
an edge through it (`e.endEdges(0).start()`), so the bridge would
continue that edge; `'g0'` at that end matches its position only.

| Parameter | Type | Description |
| --- | --- | --- |
| `start` | `"g0"` \| `"g1"` \| `"g2"` | At the start (`from`), or at both ends when it is the only value: `'g0'`, `'g1'` or `'g2'`. |
| `end` | `"g0"` \| `"g1"` \| `"g2"` | At the end (`to`): `'g0'`, `'g1'` or `'g2'`. Left out, the same as `start`. *(optional)* |

### `startMagnitude()`

How far the bridge keeps going straight before it turns, at its start:
1 by default; larger is fuller, smaller is tighter. Measured against
the distance between the two ends, so a magnitude gives the same shape
at any scale. It does nothing at a `'g0'` end, and must be greater
than zero all the same.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | A number greater than zero. |

### `endMagnitude()`

The same at its end: how far the bridge runs straight into the `to`
curve. 1 by default; nothing at a `'g0'` end. Must be greater than
zero.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | A number greater than zero. |

## Inherited

From [[api/types/curve-result]]: `edges()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
