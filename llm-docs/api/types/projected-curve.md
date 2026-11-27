---
id: api/types/projected-curve
title: ProjectedCurve
summary: "Curves thrown onto faces: `project(source, target)` written outside a sketch."
tags: [api, type, interface]
symbols: [ProjectedCurve, IProjectedCurve]
seeAlso: [api/types/curve-result]
---
# ProjectedCurve

```ts
interface ProjectedCurve extends CurveResult {
  mode(value: "normal" | "direction"): this;
  direction(value: DirectionInputLike): this;
  keep(value: "nearest" | "all"): this;
}
```

Curves thrown onto faces: `project(source, target)` written outside a
sketch. One wire per image chain, each running the same way as its
source, images in source order. The options are chained methods, in any
order.

Extends [[api/types/curve-result]].

## Methods

### `mode()`

How each point travels: `'direction'` (the default), every point along
one line, the one `.direction()` gives; `'normal'`, every point to the
closest point of the target.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `"normal"` \| `"direction"` | `'direction'` or `'normal'`. |

### `direction()`

The line every point travels along, for mode `'direction'`. It is a
line, not an arrow: the source is projected both ways along it, and
`.keep()` decides which images stay. Left out, it is the normal of the
plane the source lies in.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | [[api/types/direction-input-like]] | `'x'`, `'y'`, `'z'`, an `axis()`, a straight edge or a connector (its Z axis); or `'xy'`, `'xz'`, `'yz'`, a `plane()` or a planar face, for its normal. |

### `keep()`

Which images stay: `'nearest'` (the default) — along the direction,
what the line through each point of the source meets first, so the far
side of a body is left out and every stretch of the near side stays; in
mode `'normal'`, the image nearest the source — or `'all'`, every image,
the far side of a closed body too.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `"nearest"` \| `"all"` | `'nearest'` or `'all'`. |

## Inherited

From [[api/types/curve-result]]: `edges()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
