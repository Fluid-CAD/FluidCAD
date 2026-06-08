---
id: api/types/common
title: Common
summary: "The Common type. Extends SceneObject; adds 1 method."
tags: [api, type, interface]
symbols: [Common, ICommon]
seeAlso: [api/booleans, api/types/scene-object]
---
# Common

```ts
interface Common extends SceneObject {
  keepOriginal(value?: boolean): this;
}
```

Extends [[api/types/scene-object]].

## Methods

### `keepOriginal()`

Controls whether the original objects involved in the boolean intersection
are retained or removed after the operation.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | `true` to keep originals, `false` (default) to remove them. *(optional)* |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
