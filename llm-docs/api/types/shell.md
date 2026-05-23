---
id: api/types/shell
title: Shell
summary: "The Shell type. Extends SceneObject; adds 3 methods."
tags: [api, type, interface]
symbols: [Shell, IShell]
seeAlso: [api/shell, api/types/scene-object]
---
# Shell

```ts
interface Shell extends SceneObject {
  internalFaces(...args: (number | FaceFilter)[]): SceneObject;
  internalEdges(...args: (number | EdgeFilter)[]): SceneObject;
  join(type: ShellJoinType): this;
}
```

Extends [[api/types/scene-object]].

## Methods

### `internalFaces()`

Selects the inner wall faces created by the shell operation (from thickness removal).

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects edges created by the shell operation that are not from the original solid
or on the opening rim.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `join()`

Sets the join type used at inner-wall corners.

| Parameter | Type | Description |
| --- | --- | --- |
| `type` | `ShellJoinType` | `'arc'` (default) for rounded blends, `'intersection'` for sharp corners, or `'tangent'` for tangent-continuous blends. |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
