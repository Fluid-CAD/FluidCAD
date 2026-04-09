---
sidebar_position: 4
title: "Revolve"
---

# Revolve

`revolve()` rotates a sketch profile around an axis to create a solid of revolution — think of turning on a lathe.

```js
sketch("xz", () => {
    circle([80, 0], 40)        // circle offset from the Z axis
})

revolve("z", 275)              // revolve 275° around the Z axis
```

## Full revolution

```js
revolve("z")                   // defaults to 360°
```

## Partial revolution

```js
revolve("z", 180)              // half turn
```

The sketch should be offset from the axis of revolution — otherwise you get a zero-thickness result.

## Region picking

When a sketch has multiple regions, use `.pick()` to select which one to revolve:

```js
revolve("z").pick([80, 0])
```

:::tip[Interactive mode]
Call `.pick()` with no arguments to enter interactive mode.
:::

:::caution[Region picking can be fragile]
When you pick a region by coordinates (or by clicking in interactive mode), those coordinates are saved in your code. If the sketch dimensions change later, the pick point may fall outside the resized regions, breaking the model.

This makes `.pick()` great for **fast prototyping** or models with fixed dimensions. For parametric models where dimensions are likely to change, prefer structuring your sketches so each sketch contains only the regions you need — avoiding the need for `.pick()` altogether.
:::

## Accessing geometry

```js
const r = revolve("z", 180)

r.endFaces()       // face(s) at the end of the revolution
r.startFaces()     // face(s) at the start
r.sideFaces()      // outer surface(s)
```

## Fusion scope

```js
revolve("z").new()             // create a separate solid
revolve("z").add()             // fuse with touching solids (default)
revolve("z").remove(box)       // subtract the revolved shape from the box
```
