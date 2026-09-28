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
- A target or row cell is any mate side, a connector's copy included:
  `f.connectors.bolt.instance(k)` (copy k of `bolt`), or `bay.instance(k)`
  for a copied assembly connector.
- Rows are always explicit. Nothing follows the part's pattern: if the part
  copies `bolt` six times instead of four, add the rows. In the Replicate
  dialog, **Suggest copies** fills the rows for you — for a column whose
  connector the part copies, one row per unused member of its family, in
  slot order; otherwise one per unused connector on the same part.

```js
import { assembly, insert, mate, replicate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { standoff } from "./standoff.part.js";

export const standoffs = assembly("standoffs", () => {
  const base = insert(plate).grounded();

  // the seed: one standoff fastened onto the first mounting hole
  const first = insert(standoff);
  mate("fastened", base.connectors.hole, first.connectors.foot);

  // three more, one per remaining hole: the plate copies its `hole`
  // connector onto them with
  //   copy("linear", ["x", "y"], { count: [2, 2], offset: [60, 35] }, hole)
  replicate(first, [base.connectors.hole], [
    [base.connectors.hole.instance(1)],
    [base.connectors.hole.instance(2)],
    [base.connectors.hole.instance(3)],
  ]);
});
```

Use `repeat()` / `copy()` for geometric patterns inside a part (and
`copy()` of assembly connectors at an assembly's top level); `replicate()`
is for placing a mated thing again on new references.
