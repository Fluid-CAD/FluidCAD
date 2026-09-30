---
id: api/types/hole
title: Hole
summary: "A fastener hole cut into the scope solids at one or more placements."
tags: [api, type, interface]
symbols: [Hole, IHole]
seeAlso: [api/hole, api/types/scene-object]
---
# Hole

```ts
interface Hole extends SceneObject {
  clearance(fit?: "normal" | "close" | "loose"): this;
  tapped(pitch?: number): this;
  counterbore(diameter?: number, depth?: number): this;
  countersink(diameter?: number, angle?: number): this;
  depth(distance: number, tipAngle?: number): this;
  scope(...objects: SceneObject[]): this;
  faces(...indices: number[]): ISelection;
  edges(...indices: number[]): ISelection;
  startEdges(...indices: number[]): ISelection;
  endEdges(...indices: number[]): ISelection;
}
```

A fastener hole cut into the scope solids at one or more placements. Created
with `hole(size, ...placements)`; the chains below refine it and must come
before `.scope()`.

Extends [[api/types/scene-object]].

## Methods

### `clearance()`

A clearance hole for the fastener size, from the ISO 273 / ASME B18.2.8
tables. Fastener sizes only (`hole('M6', …)`).

| Parameter | Type | Description |
| --- | --- | --- |
| `fit` | `"normal"` \| `"close"` \| `"loose"` | 'close', 'normal' (default) or 'loose' *(optional)* |

### `tapped()`

A tapped hole for the fastener size, cut at its tap-drill diameter.
Threads are not modelled yet; the size and pitch are kept for a later
thread feature. Fastener sizes only.

| Parameter | Type | Description |
| --- | --- | --- |
| `pitch` | `number` | The thread pitch in mm (metric) or threads per inch (inch); omitted = coarse *(optional)* |

### `counterbore()`

A counterbore at the entry. Without values the socket-head cap screw
table for the fastener size is used.

| Parameter | Type | Description |
| --- | --- | --- |
| `diameter` | `number` | Counterbore diameter *(optional)* |
| `depth` | `number` | Counterbore depth from the surface *(optional)* |

### `countersink()`

A countersink at the entry. Without values the flat-head screw table for
the fastener size is used (90° metric, 82° inch).

| Parameter | Type | Description |
| --- | --- | --- |
| `diameter` | `number` | Countersink diameter at the surface *(optional)* |
| `angle` | `number` | Included angle in degrees *(optional)* |

### `depth()`

A blind hole. Without this chain the hole runs through every solid in scope.

| Parameter | Type | Description |
| --- | --- | --- |
| `distance` | `number` | Depth from the surface to the shoulder (the full-diameter depth) |
| `tipAngle` | `number` | Drill point included angle below the shoulder (118 for a standard drill); omitted = flat bottom *(optional)* |

### `scope()`

Narrows the cut to specific solids.

| Parameter | Type | Description |
| --- | --- | --- |
| `...objects` | [[api/types/scene-object]][] | The solids to cut *(optional)* |

### `faces()`

Selects the walls the hole created — the bore, the counterbore step, the countersink cone and the drill point.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...indices` | `number`[] | Optional indices into the wall faces *(optional)* |

### `edges()`

Selects every edge the hole created: the rims on the surfaces and the creases inside.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...indices` | `number`[] | Optional indices into the edges *(optional)* |

### `startEdges()`

Selects the rims where the hole meets the surface it enters.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...indices` | `number`[] | Optional indices into the rims *(optional)* |

### `endEdges()`

Selects the rims at the bottom of a blind hole, or where a through hole leaves the solid.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...indices` | `number`[] | Optional indices into the rims *(optional)* |

## Inherited

From [[api/types/scene-object]]: `name()`
