---
sidebar_position: 2
title: "Extrude"
---

# Extrude

`extrude()` pulls a sketch upward (along the plane's normal) into a solid. It's the most common way to turn a 2D profile into 3D geometry.

```js
sketch("xy", () => {
    rect(100, 60).center()
})

const e = extrude(30)          // extrude 30 units
```

## No-argument extrude

```js
extrude()                      // uses a default distance of 25
```

When called with no arguments, `extrude()` uses a default distance and supports interactive mouse input in the viewport — drag to set the distance visually.

## Symmetric extrude

Extrude equally in both directions from the sketch plane:

```js
extrude(40).symmetric()        // 20 up and 20 down
```

## Draft angle

Add a taper to the extrusion:

```js
extrude(30).draft(5)           // 5° draft angle — the shape narrows as it goes up
```

## Region picking

When a sketch has multiple overlapping shapes that create several regions, use `.pick()` to select which region to extrude:

```js
sketch("xy", () => {
    circle(60)
    circle(30)
})

extrude(20).pick([20, 0])      // extrude only the ring region near [20, 0]
```

:::tip[Interactive mode]
Call `.pick()` with no arguments to enter interactive mode. Click on regions in the viewport to select them.
:::

:::caution[Region picking can be fragile]
When you pick a region by coordinates (or by clicking in interactive mode), those coordinates are saved in your code. If the sketch dimensions change later, the pick point may fall outside the resized regions, breaking the model.

This makes `.pick()` great for **fast prototyping** or models with fixed dimensions. For parametric models where dimensions are likely to change, prefer structuring your sketches so each sketch contains only the regions you need — avoiding the need for `.pick()` altogether.
:::

## Accessing geometry

```js
const e = extrude(30)

e.endFaces()       // top face(s)
e.startFaces()     // bottom face(s)
e.sideFaces()      // side face(s)
e.endEdges()       // edges on the top
e.startEdges()     // edges on the bottom
e.sideEdges()      // edges on the sides
e.internalEdges()  // edges created inside (from fusion)
e.internalFaces()  // faces created inside (from fusion)
```

## Fusion scope

By default, extrude fuses with any touching solid. Control this with:

```js
extrude(30).new()              // create a separate solid, don't fuse
extrude(30).add()              // fuse with all touching solids (default)
```
