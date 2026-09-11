---
id: api/types/repeat
title: Repeat
summary: "A 3D `repeat()` — linear, circular, mirror, rotate or matrix."
tags: [api, type, interface]
symbols: [Repeat, IRepeat]
seeAlso: [api/types/scene-object]
---
# Repeat

```ts
interface Repeat extends SceneObject {
  instance(index: number): RepeatInstance;
}
```

A 3D `repeat()` — linear, circular, mirror, rotate or matrix. Its
instances are addressable by slot, so one clone of a pattern can be
selected without describing its position numerically.

Extends [[api/types/scene-object]].

## Methods

### `instance()`

Selects one instance of the pattern: the repeated features at that slot
as a whole geometry, plus their forwarded bucket accessors when the
repeat clones a single feature (`r.instance(1).endEdges()`). Slot 0 is
the original for circular, mirror, rotate and matrix repeats. Linear
repeats linearize the grid in axis order (the first axis varies
slowest) with the original at its own slot — 0 when not centered, the
center slot when centered — the same numbering the `skip` option uses;
a skipped slot is an error.

**Returns**: [[api/types/repeat-instance]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | The slot index. |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
