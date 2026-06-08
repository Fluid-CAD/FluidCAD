---
id: api/types/mirror
title: Mirror
summary: "The Mirror type. Extends BooleanOperation; adds 1 method."
tags: [api, type, interface]
symbols: [Mirror, IMirror]
seeAlso: [api/mirror, api/types/boolean-operation]
---
# Mirror

```ts
interface Mirror extends BooleanOperation {
  exclude(...objects: SceneObject[]): this;
}
```

Extends [[api/types/boolean-operation]].

## Methods

### `exclude()`

Excludes the given objects from the mirror operation. Useful when
mirroring "everything" but a few specific objects should be skipped,
or when narrowing an explicit target list.

| Parameter | Type | Description |
| --- | --- | --- |
| `...objects` | [[api/types/scene-object]][] | The objects to exclude from mirroring. *(optional)* |

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
