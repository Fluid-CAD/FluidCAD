---
id: api/types/linear-repeat-options
title: LinearRepeatOptions
summary: "Options for `repeat(\"linear\", ...)`."
tags: [api, type, options]
symbols: [LinearRepeatOptions]
seeAlso: [api/repeat]
---
# LinearRepeatOptions

```ts
type LinearRepeatOptions = {
  count: number | number[];
  offset?: number | number[];
  length?: number | number[];
  centered?: boolean;
  skip?: number[][];
};
```

Options accepted by the linear variant of `repeat()`. Controls how many copies are placed and how they are spaced along the chosen axes.

## Properties

| Property | Type | Description |
| --- | --- | --- |
| `count` | `number` \| `number`[] | Number of instances per axis (including the original) |
| `offset` | `number` \| `number`[] | Spacing between each instance. Cannot be used with `length`. *(optional)* |
| `length` | `number` \| `number`[] | Total span to distribute instances across (evenly spaced). Cannot be used with `offset`. *(optional)* |
| `centered` | `boolean` | When `true`, centers the pattern around the original object's position *(optional)* |
| `skip` | `number`[][] | Index tuples to skip (e.g. `[[1], [3]]` for single axis, `[[1, 2]]` for multi-axis) *(optional)* |
