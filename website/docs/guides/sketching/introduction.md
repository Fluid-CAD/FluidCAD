---
sidebar_position: 1
title: "Introduction"
---

# 2D Sketching

Every 3D model starts with a 2D sketch. A sketch draws flat shapes on a plane, which you can then extrude, cut, revolve, or sweep into 3D geometry.

```js
sketch("xy", () => {
    rect(100, 60).center()
})
```

## Using 2D geometries outside a sketch

All 2D geometries can be used outside a `sketch()` block by passing the plane as the last argument. This is consistent across every 2D shape:

```js
circle(50, "xy")               // circle on the XY plane
rect(100, 60, "front")         // rectangle on the front plane
line([0, 0], [100, 50], "xz")  // line on the XZ plane
slot(80, 20, "xy")             // slot on the XY plane
arc(50, 0, 90, "front")       // arc on the front plane
```

This is a shorthand — it's equivalent to wrapping the shape in a `sketch()` call on that plane.

## Sketch planes

A sketch needs a plane to draw on. You can use string names, custom planes, or faces from previous operations.

### String names

```js
sketch("xy", () => { ... })    // XY plane (horizontal, looking down) — same as "top"
sketch("xz", () => { ... })    // XZ plane (vertical, looking from front) — same as "front"
sketch("yz", () => { ... })    // YZ plane (vertical, looking from right) — same as "right"
```

Each plane has an alias and a negative version:

| String | Alias | Negative | Negative alias |
|--------|-------|----------|----------------|
| `"xy"` | `"top"` | `"-xy"` | `"bottom"` |
| `"xz"` | `"front"` | `"-xz"` | `"back"` |
| `"yz"` | `"right"` | `"-yz"` | `"left"` |

### Custom planes

Use `plane()` to create offset or rotated planes:

```js
import { plane } from 'fluidcad/core';

const p = plane("xy", { offset: 50 })           // XY plane shifted 50 units up
const p2 = plane("xz", { rotateX: 45 })         // XZ plane rotated 45° around X
const p3 = plane("xy", { offset: 30, rotateZ: 90 })  // combined
```

### Sketching on a face

You can sketch directly on a face from a previous operation:

```js
const e = extrude(30)

sketch(e.endFaces(), () => {
    circle(30)
})
```

When you sketch on a face, the current position is automatically placed at the **center of that face**. This is convenient in most cases — a `circle(30)` will be centered on the face without any extra positioning. If you need to draw from the origin instead, use `move([0, 0])` to reset the position.

This is how you build on top of existing geometry — sketch on the top face, then extrude or cut from there.

## Movement

Inside a sketch, there is a **current position** — think of it as a pen on paper. Drawing commands start from the current position, and movement commands reposition it without drawing.

```js
sketch("xy", () => {
    move([30, 20])             // move to absolute position [30, 20]
    rect(50, 30)               // draw here

    hMove(80)                  // move 80 units to the right (relative)
    circle(40)                 // draw here
})
```

- **`move([x, y])`** — move to an absolute position
- **`hMove(distance)`** — move horizontally (relative)
- **`vMove(distance)`** — move vertically (relative)

## The sketch viewport

When you're working inside a sketch, the viewport shows visual helpers to guide you:

- **Orange dot** — the current drawing position. This is where the next shape or line will start from.
- **Orange arrow** — the current tangent direction. This shows which way the pen is pointing, which matters for tangent-continuous operations like `tArc()` and `tLine()`.
- **Blue dots** — endpoints of sketch edges. These mark where geometry segments begin and end.

These indicators update live as you add shapes and lines, so you always know where you are in the sketch.

## How sketch faces are created

When a sketch is used by an operation like `extrude()` or `cut()`, FluidCAD turns the 2D geometry into faces using these rules:

- **Overlapping shapes are fused automatically.** If two closed shapes intersect, their outlines merge into a single combined face. You don't need to trim or manually join them.
- **Internal closed shapes are holes.** A closed shape inside another closed shape is treated as a cutout — the inner area is removed. This is how you create rings, mounting holes, and pockets.
- **Open or loose geometry is ignored.** Lines, arcs, or curves that don't form a closed shape are skipped when building faces. They can still be useful as [guides](./guides).

```js
sketch("xy", () => {
    circle(60)                 // outer circle
    circle(30)                 // inner circle → becomes a hole
})

extrude(20)                    // extrudes the ring between the two circles
```

If you want an internal shape to be solid instead of a hole, chain `.drill(false)` on the operation:

```js
extrude(20).drill(false)       // inner circle is NOT treated as a hole
```
