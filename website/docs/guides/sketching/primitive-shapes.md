---
sidebar_position: 2
title: "Primitive Geometries"
---

# Primitive Geometries

Primitive geometries are the building blocks of sketches — lines, arcs, and curves. They follow a "pen" model: each command starts from where the last one ended.

## circle

`circle()` takes a **diameter** (not radius):

```js
sketch("xy", () => {
    circle(50)                 // diameter 50 at the origin
    circle([30, 20], 40)      // diameter 40 centered at [30, 20]
    circle()                   // default diameter of 40
})
```

## line

```js
sketch("xy", () => {
    line([0, 0], [100, 0])     // from [0,0] to [100,0]
    line([100, 50])            // continues to [100, 50]
    line([0, 0])               // back to start, closing the shape
})
```

## Directional lines

```js
sketch("xy", () => {
    line([0, 0], [50, 0])      // starting point
    vLine(40)                  // vertical: go up 40
    hLine(-50)                 // horizontal: go left 50
    line([0, 0])               // close the shape
})
```

- **`hLine(distance)`** — horizontal line (positive = right, negative = left)
- **`vLine(distance)`** — vertical line (positive = up, negative = down)
- **`aLine(angle, distance)`** — line at an angle (degrees) for a given distance

```js
sketch("xy", () => {
    line([0, 0], [50, 0])
    aLine(60, 40)              // 60° angle, 40 units long
    line([0, 0])
})
```

## arc

```js
sketch("xy", () => {
    arc(50, 0, 90)             // radius 50, from 0° to 90°
})
```

## Tangent arcs

`tArc()` draws an arc that is tangent to the previous line or arc — the arc starts in the same direction the pen is currently pointing (shown by the orange arrow in the viewport). This creates smooth, continuous curves:

```js
sketch("front", () => {
    vLine(100)
    tArc(50, 180)              // tangent arc: radius 50, sweep 180°
    tArc(80, -270)             // another tangent arc
})
```

## bezier

Draws bezier curves through control points:

```js
sketch("xy", () => {
    bezier([0, 0], [50, 100], [100, 0])   // quadratic bezier (1 control point)
})
```

The last point is the endpoint. Points in between are control points:
- 2 points = straight line
- 3 points = quadratic bezier (1 control point)
- 4 points = cubic bezier (2 control points)

:::tip[Interactive mode]
Call `bezier()` with no arguments to enter interactive mode. Click in the viewport to place control points with a live preview of the curve. Use Ctrl+click to drag existing points, and Escape to undo.
:::

