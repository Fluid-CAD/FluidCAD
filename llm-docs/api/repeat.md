---
id: api/repeat
title: repeat(kind, axis | plane, options, ...features)
summary: Re-applies a modeling feature (extrude, cut, fillet, …) at multiple positions, producing one solid with N copies of the feature. Refuses connectors — copy them with copy(), or follow the repeat with copy(holes, bolt).
tags: [api, pattern, transform]
symbols: [repeat]
seeAlso: [api/extrude, api/copy, api/connector, concepts/scene-graph]
---

# repeat

Imported from `fluidcad/core`.

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

**Circular step.** A full turn (`angle: 360`, or any whole number of
turns) steps `angle / count`: six instances 60° apart. Any other angle
steps `angle / (count - 1)`, so the last instance lands on `angle`:
`{ count: 4, angle: 90 }` puts instances at 0°, 30°, 60° and 90°. `copy()`
always steps `angle / count` (0°, 22.5°, 45°, 67.5° for the same options) —
the two differ on partial arcs, by design.

**Connectors are refused.** `repeat()` re-applies features, and a
connector is a frame, not a feature — an explicit connector target, or a
connector as the implicit last object, refuses the statement on its row:
`repeat() re-applies features — copy a connector with copy('circular',
axis, options, bolt), or copy(<this repeat>, bolt) to follow it`. Repeat
the hole, then lay the connector on its instances with
`copy(holes, bolt)` (see [[api/copy]]).

## Examples

```fluid.js
import { circle, cut, extrude, line, origin, repeat, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, diameter, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

// Cut one pocket, then repeat the cut across a 4×2 grid → one solid with 8 pockets
sketch("xy", () => {
  const b = line([-100, -50], [100, -50]);
  const r = line([100, -50], [100, 50]);
  const t = line([100, 50], [-100, 50]);
  const l = line([-100, 50], [-100, -50]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 200);
  distance(r.start(), r.end(), 100);
});
extrude(20);
sketch("xy", () => {
  const c = circle([0, 0], 5);
  coincident(c.center(), origin());
  diameter(c, 5);
});
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
| Copies of a connector (mate frame) in a row or around an axis | `copy("linear" \| "circular", …, bolt)` — `repeat()` refuses connectors |
| A connector on every instance of a repeated hole | `copy(holes, bolt)` — follows the repeat's own slots and moves when it changes |
| A partial arc whose last instance lands on `angle` | `repeat()` (`angle / (count - 1)`); `copy()` steps `angle / count` |

The key intuition: `copy()` duplicates a finished shape; `repeat()`
re-executes a feature. The latter respects auto-fusion semantics, so
overlapping copies merge rather than producing duplicate geometry. A
connector is neither a shape nor a feature to re-run: only `copy()` takes
one.

See [[api/extrude]] / [[concepts/scene-graph]] for the underlying feature
model `repeat` re-applies.
