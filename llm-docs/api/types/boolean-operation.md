---
id: api/types/boolean-operation
title: BooleanOperation
summary: "The BooleanOperation type. Extends SceneObject; adds 4 methods."
tags: [api, type, interface]
symbols: [BooleanOperation, IBooleanOperation]
seeAlso: [api/types/scene-object, concepts/scene-graph]
---
# BooleanOperation

```ts
interface BooleanOperation extends SceneObject {
  add(): this;
  'new'(): this;
  remove(): this;
  scope(...objects: SceneObject[]): this;
}
```

Extends [[api/types/scene-object]].

## Methods

### `add()`

Additive boolean operation — fuses the result with all intersecting scene objects.
Use `.scope()` to target specific objects.

### `'new'()`

No boolean operation — keeps the result as a standalone shape,
separate from all other scene objects.

### `remove()`

Subtractive boolean operation — cuts the result from all intersecting scene objects.
Use `.scope()` to target specific objects.

### `scope()`

Narrows the boolean operation scope to specific target objects.
Must be chained after `.add()` or `.remove()`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...objects` | [[api/types/scene-object]][] | The target objects to operate on. *(optional)* |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
