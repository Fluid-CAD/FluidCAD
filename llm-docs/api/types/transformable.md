---
id: api/types/transformable
title: Transformable
summary: "Scene objects that can be chained with world-space transformations."
tags: [api, type, interface]
symbols: [Transformable, ITransformable]
seeAlso: [api/types/scene-object, api/translate, api/rotate]
---
# Transformable

```ts
interface Transformable extends SceneObject {
  transform(matrix: Matrix4): this;
  translate(x: NumberParam): this;
  translate(x: NumberParam, y: NumberParam): this;
  translate(x: NumberParam, y: NumberParam, z: NumberParam): this;
  translate(offset: PointLike): this;
  rotate(angle: NumberParam): this;
  rotate(axis: AxisLike, angle: NumberParam): this;
  mirror(plane: PlaneLike): this;
  mirror(axis: AxisLike): this;
}
```

Scene objects that can be chained with world-space transformations.
The chained form `obj.translate(...)` / `obj.rotate(...)` / `obj.mirror(...)`
applies the transform to the object's built shapes; it does not create
a separate history entry like the free-function `translate()` does.

Container objects (sketches, parts, repeat/mirror features) deliberately
do not expose this interface — apply transforms to their contents instead.

Extends [[api/types/scene-object]].

## Methods

### `transform()`

Composes a 4x4 transformation matrix onto this object. Applied to the
object's own shapes after build. Chained calls compose left-to-right:
`.translate(T).rotate(R)` applies translation first, then rotation.

| Parameter | Type | Description |
| --- | --- | --- |
| `matrix` | `Matrix4` |  |

### `translate()`

```ts
translate(x: NumberParam): this
translate(x: NumberParam, y: NumberParam): this
translate(x: NumberParam, y: NumberParam, z: NumberParam): this
translate(offset: PointLike): this
```

Translate along X.

| Parameter | Type | Description |
| --- | --- | --- |
| `x` | `NumberParam` |  |
| `y` | `NumberParam` |  |
| `z` | `NumberParam` |  |

### `rotate()`

```ts
rotate(angle: NumberParam): this
rotate(axis: AxisLike, angle: NumberParam): this
```

Rotate by an angle around world Z through the origin.

| Parameter | Type | Description |
| --- | --- | --- |
| `axis` | [[api/types/axis-like]] | The axis to rotate around. Use `local(...)` to reference a sketch-local axis. |
| `angle` | `NumberParam` | Rotation in degrees. |

### `mirror()`

```ts
mirror(plane: PlaneLike): this
mirror(axis: AxisLike): this
```

Mirror across a plane.

| Parameter | Type | Description |
| --- | --- | --- |
| `plane` | [[api/types/plane-like]] |  |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
