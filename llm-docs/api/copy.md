---
id: api/copy
title: copy(kind, axis | plane, options, ...objects)
summary: Duplicates a finished shape at multiple positions. Each copy is independent of the original. Use `repeat()` when you instead want the modeling feature itself re-applied.
tags: [api, transform, pattern]
symbols: [copy]
seeAlso: [api/repeat, api/translate, api/mirror]
---

# copy

Imported from `fluidcad/core`.

```ts
// Linear
copy("linear", axis: AxisLike, options, ...objects)
copy("linear", axes: AxisLike[], options, ...objects)

// Circular
copy("circular", axis: AxisLike, options, ...objects)        // 3D
copy("circular", center: Point2D, options, ...objects)       // inside a sketch
```

## Linear options (`LinearCopyOptions` / `LinearRepeatOptions`)

**Required:** `count` plus exactly one of `offset` or `length`.

- `count: number | number[]` — instances per axis (including original).
- `offset: number | number[]` — spacing between instances. Mutually
  exclusive with `length`.
- `length: number | number[]` — total span; instances are evenly
  distributed. Mutually exclusive with `offset`.
- `centered: boolean` — center the pattern around the original.
- `skip: number[][]` — index tuples to skip (per-axis).

## Circular options (`CircularCopyOptions` / `CircularRepeatOptions`)

**Required:** `count` plus exactly one of `offset` or `angle`.

- `count: number` — instances (including original).
- `angle: number` — total sweep in degrees; instances are evenly
  distributed. Mutually exclusive with `offset`.
- `offset: number` — angular spacing in degrees between instances.
  Mutually exclusive with `angle`.
- `centered: boolean` — center the pattern around the original.
- `skip: number[]` — indices to skip.

`copy()` snapshots the finished shape — copies don't share the
modeling history of the source. For feature-aware patterns (where each
position re-runs the original op) use [[api/repeat]].

## Example

```fluid.js
import { circle, copy, extrude, sketch } from "fluidcad/core";

sketch("xy", () => circle(8));
const pin = extrude(20).new();
copy("linear", "x", { count: 4, offset: 25 }, pin);
```

See [[api/repeat]] for the feature-replay alternative and
[[api/translate]] for the single-instance case.
