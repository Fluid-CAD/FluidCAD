---
id: api/types/repeat-instance
title: RepeatInstance
summary: "One instance of a 3D `repeat()` pattern."
tags: [api, type, interface]
symbols: [RepeatInstance, IRepeatInstance]
seeAlso: [api/types/select]
---
# RepeatInstance

```ts
interface RepeatInstance extends Select {
  startFaces(...args: (number | FaceFilter)[]): ISelection;
  endFaces(...args: (number | FaceFilter)[]): ISelection;
  startEdges(...args: (number | EdgeFilter)[]): ISelection;
  endEdges(...args: (number | EdgeFilter)[]): ISelection;
  sideFaces(...args: (number | FaceFilter)[]): ISelection;
  sideEdges(...args: (number | EdgeFilter)[]): ISelection;
  internalFaces(...args: (number | FaceFilter)[]): ISelection;
  internalEdges(...args: (number | EdgeFilter)[]): ISelection;
  capFaces(...args: (number | FaceFilter)[]): ISelection;
  capEdges(...args: (number | EdgeFilter)[]): ISelection;
  edges(...indices: number[]): ISelection;
}
```

One instance of a 3D `repeat()` pattern. As a whole it is the repeated
geometry at that slot — a whole-geometry operand (`fillet(2, r.instance(1))`)
and a `from()` scope (`select(edge().from(r.instance(1)).circle())`).
When the repeat clones exactly one feature per instance, the instance
also forwards that feature's bucket accessors: `r.instance(1).endEdges()`
is the clone's own end-edge bucket, with the same index and filter
arguments the original's accessor takes.

Extends [[api/types/select]].

## Methods

### `startFaces()`

The repeated feature's start faces at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `endFaces()`

The repeated feature's end (cap) faces at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `startEdges()`

The repeated feature's start edges at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

The repeated feature's end (cap) edges at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `sideFaces()`

The repeated feature's side faces at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `sideEdges()`

The repeated feature's side edges at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `internalFaces()`

The repeated feature's internal faces at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

The repeated feature's internal edges at this instance.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `capFaces()`

The repeated feature's cap faces at this instance (thin-walled extrudes).

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `capEdges()`

The repeated feature's cap edges at this instance (thin-walled extrudes).

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `edges()`

The repeated feature's section edges at this instance, by index.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...indices` | `number`[] | Edge indices within the section-edge bucket. *(optional)* |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
