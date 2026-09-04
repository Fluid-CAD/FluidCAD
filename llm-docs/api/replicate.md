---
id: api/replicate
title: "replicate(seed, targets, rows)"
summary: "Copies a mated instance or sub-assembly onto new mate targets — \"copy with mates\", not a geometric pattern. Each replica gets the seed's mates re-targeted to its own row and moves independently; returns the replica handles in row order."
tags: [api, assembly, pattern]
symbols: [replicate]
seeAlso: [api/insert, api/mate, api/repeat, api/copy, concepts/assemblies]
---

# replicate

Imported from `fluidcad/core`. Only allowed in `*.assembly.js` files.

```ts
replicate(seed: Instance | Occurrence, targets: MateSide[], rows: MateSide[][]): Instance[] | Occurrence[]
```

| argument | meaning |
|----------|---------|
| `seed` | the handle `insert()` returned for the instance or sub-assembly to copy (inserted in this assembly body) |
| `targets` | the seed's **outer** mate sides that vary per replica — the connectors / exposures on OTHER bodies its mates reference; one column each. Outer sides not listed stay shared by every replica |
| `rows` | one array per replica, one entry per target: `rows[k][j]` replaces `targets[j]` in replica `k`'s mates; at least one row |

Rules:

- Only mates written **before** the statement replicate; their options
  (flip, rotate, offset, limits) are copied verbatim.
- Replicas start at the seed's pose, are never grounded (their mates place
  them), and are named `<seed name> (2)`, `(3)`, …
- The return value is the replica handles in row order, so
  `const [b, c] = replicate(...)` can name or mate them further.
- A sub-assembly seed is re-run with the same parameters, inner mates
  included.

```js
import { assembly, insert, mate, replicate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { standoff } from "./standoff.part.js";

export const standoffs = assembly("standoffs", () => {
  const base = insert(plate).grounded();

  // the seed: one standoff fastened onto the first mounting hole
  const first = insert(standoff);
  mate("fastened", base.connectors.hole1, first.connectors.foot);

  // three more, one per remaining hole
  replicate(first, [base.connectors.hole1], [
    [base.connectors.hole2],
    [base.connectors.hole3],
    [base.connectors.hole4],
  ]);
});
```

Use `repeat()` / `copy()` for geometric patterns inside a part; `replicate()`
is for placing a mated thing again on new references.
