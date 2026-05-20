---
id: api/repeat
title: repeat(kind, axis | plane, options, ...features)
summary: Re-applies a modeling feature (extrude, cut, fillet, …) at multiple positions, producing one solid with N copies of the feature.
tags: [api, pattern, transform]
symbols: [repeat]
seeAlso: [api/extrude, concepts/scene-graph]
---

# repeat

```ts
repeat("linear", axis | axes, options, ...objects)
repeat("circular", axis, options, ...objects)
repeat("mirror", plane, ...objects)
repeat("rotate", axis, angle?, ...objects)   // angle defaults to 90°
repeat(matrix: Matrix4, ...objects)
```

`repeat()` re-runs the modeling feature itself at new positions. Pass the
result of an `extrude()`, `cut()`, `fillet()`, etc. as the trailing
argument — each repetition re-executes that operation, so the output is
**one solid with N copies of the feature**.

## Required options

- **`linear`** — `count` plus exactly one of `offset` (spacing between
  instances) or `length` (total span, distributed evenly). For
  multi-axis linear repeats, pass arrays.
- **`circular`** — `count` plus exactly one of `offset` (degrees between
  instances) or `angle` (total sweep, distributed evenly).

Passing `count` alone is not enough — the runtime needs either the
spacing or the span.

## Examples

```fluid.js
// Cut one pocket, then repeat the cut across a 4×2 grid → one solid with 8 pockets
sketch("xy", () => rect(200, 100).centered());
extrude(20);
sketch("xy", () => circle(5));
const pocket = cut(10);
repeat("linear", ["x", "y"], { count: [4, 2], offset: [30, 30] }, pocket);
```

```js
// Mirror a boss across the front plane
const boss = extrude(15);
repeat("mirror", "front", boss);

// 6 circular copies evenly distributed around Z (full 360°)
const spoke = extrude(20);
repeat("circular", "z", { count: 6, angle: 360 }, spoke);

// Same idea, but spec the angular spacing directly
repeat("circular", "z", { count: 6, offset: 60 }, spoke);
```

## repeat() vs copy()

| You want… | Use |
|-----------|-----|
| Re-run a feature so it cuts/extrudes into the same solid at each position | `repeat()` |
| One solid with multiple pockets/bosses | `repeat()` with the cut/extrude result |
| Clone the whole finished shape at new positions (each copy independent) | `copy()` |
| Many separate solids of the same shape | `copy()` with `.new()` on the original |
| Mirror a feature across a plane | `repeat("mirror", plane, feature)` |

The key intuition: `copy()` duplicates a finished shape; `repeat()`
re-executes a feature. The latter respects auto-fusion semantics, so
overlapping copies merge rather than producing duplicate geometry.

See [[api/extrude]] / [[concepts/scene-graph]] for the underlying feature
model `repeat` re-applies.
