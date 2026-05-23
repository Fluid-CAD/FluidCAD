---
id: api/types/trim
title: Trim
summary: "The Trim type. Defines 1 method."
tags: [api, type, interface]
symbols: [Trim, ITrim]
seeAlso: [api/split-trim]
---
# Trim

```ts
interface Trim {
  pick(...points: Point2DLike[]): Trim;
}
```

## Methods

### `pick()`

Enters interactive trimming mode, optionally trimming edges at the given points.

**Returns**: [[api/types/trim]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...points` | [[api/types/point2dlike]][] | Points where geometry should be trimmed; the nearest edge segment to each point is removed. *(optional)* |
