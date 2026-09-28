---
id: api/types/connector
title: Connector
summary: "A mate connector attached to a part — a coordinate frame the assembly pipeline can reference."
tags: [api, type, interface]
symbols: [Connector, IConnector]
seeAlso: [api/types/scene-object]
---
# Connector

```ts
interface Connector extends SceneObject {
  rotate(axis: "x" | "y" | "z", angle: number): this;
  offset(x: number, y?: number, z?: number): this;
  instance(slot: number): Connector;
}
```

A mate connector attached to a part — a coordinate frame the assembly
pipeline can reference. Returned by the `connector(...)` DSL.

`rotate` and `offset` adjust the frame in its **local** axes (not world),
so the connector's own xDirection / yDirection / normal define the
transform — chaining calls composes left-to-right against the *current*
(already-transformed) frame.

Extends [[api/types/scene-object]].

## Methods

### `rotate()`

Rotate the connector frame around its own local X, Y, or Z axis,
pivoting at its current origin.

| Parameter | Type | Description |
| --- | --- | --- |
| `axis` | `"x"` \| `"y"` \| `"z"` | "x", "y", or "z" — the connector's local axis name. |
| `angle` | `number` | Rotation in degrees. |

### `offset()`

Translate the connector origin along its own local axes:
`x · xDirection + y · yDirection + z · normal`. Omitted `y` / `z`
default to 0. Axes are unchanged.

| Parameter | Type | Description |
| --- | --- | --- |
| `x` | `number` |  |
| `y` | `number` |  *(optional)* |
| `z` | `number` |  *(optional)* |

### `instance()`

Copy `slot` of this connector, made by the `copy()` statement that
copies it: `copy('circular', 'z', { count: 6, angle: 360 }, bolt)` makes
`bolt.instance(1)` … `bolt.instance(5)`, and an assembly mates one as
`f.connectors.bolt.instance(3)`.

Slots are numbered like `repeat().instance(k)`: a linear grid counts its
cells with the first axis varying slowest, the original keeping its own
cell (0, or the centre cell when `centered`); a circular copy counts
rotation steps from the original at 0. A copy that follows a repeat —
`copy(holes, bolt)` — takes the repeat's own slots, so `bolt.instance(k)`
sits on `holes.instance(k)`. The original's slot is the connector
itself. A copy is the connector's frame moved by the pattern — it does
not re-attach to geometry at its new place. A slot the copy skipped, a
slot out of range, or a connector nothing copies throws.

**Returns**: [[api/types/connector]].

| Parameter | Type | Description |
| --- | --- | --- |
| `slot` | `number` | The pattern slot. |

## Inherited

From [[api/types/scene-object]]: `name()`
