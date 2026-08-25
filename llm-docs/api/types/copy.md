---
id: api/types/copy
title: Copy
summary: "The Copy type. Extends SceneObject; adds 1 method."
tags: [api, type, interface]
symbols: [Copy, ICopy]
seeAlso: [api/types/scene-object]
---
# Copy

```ts
interface Copy extends SceneObject {
  instance(index: number): SceneObject;
}
```

Extends [[api/types/scene-object]].

## Methods

### `instance()`

Selects one grid slot of a 2D (in-sketch) copy as a whole geometry —
every edge at that position, usable wherever a whole geometry operand is
accepted (e.g. `offset(2, cp.instance(1))`). The copy owns only the
duplicates it stamps; the original keeps its own statement, and its slot
resolves through that source geometry. Linear copies linearize the grid
in axis order (the first axis varies slowest), with the original at its
own slot — 0 when not centered, the center slot when centered. Circular
copies count rotation steps with the original at 0, the same numbering
the `skip` option uses. 3D copies do not support this accessor.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | The grid-slot index. |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
