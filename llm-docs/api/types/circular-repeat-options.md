---
id: api/types/circular-repeat-options
title: CircularRepeatOptions
summary: "Options for `repeat(\"circular\", ...)`."
tags: [api, type, options]
symbols: [CircularRepeatOptions]
seeAlso: [api/repeat]
---
# CircularRepeatOptions

```ts
type CircularRepeatOptions = {
  count: number;
  angle?: number;
  offset?: number;
  centered?: boolean;
  skip?: number[];
};
```

Options accepted by the circular variant of `repeat()`. Controls how many copies are placed and how they sweep around the chosen axis.

## Properties

| Property | Type | Description |
| --- | --- | --- |
| `count` | `number` | Number of instances (including the original) |
| `angle` | `number` | Total angle to spread across. Cannot be used with `offset`. *(optional)* |
| `offset` | `number` | Angle between each instance. Cannot be used with `angle`. *(optional)* |
| `centered` | `boolean` | When `true`, centers the pattern around the original object's position *(optional)* |
| `skip` | `number`[] | Indices to skip (e.g. `[2, 4]` to skip the 3rd and 5th instances) *(optional)* |
