---
sidebar_position: 5
title: "Constrained Geometry"
---

# Constrained Geometry

Constrained geometry lets you create lines, arcs, and circles that are **tangent to** existing sketch elements. Instead of calculating positions and angles by hand, you describe the relationship you want and FluidCAD solves the geometry for you.

The three constrained primitives are:
- **`tLine()`** — a line tangent to one or two objects
- **`tArc()`** — an arc tangent to objects, points, or the previous element
- **`tCircle()`** — a circle tangent to two objects

## Constraint qualifiers

When a constrained shape is tangent to a circle or curve, you often need to specify _how_ it should be tangent. Import qualifiers from `fluidcad/constraints`:

```js
import { outside, enclosing, enclosed } from 'fluidcad/constraints';
```

- **`outside(obj)`** — tangent on the outside of the circle/curve
- **`enclosing(obj)`** — the result encloses the circle/curve
- **`enclosed(obj)`** — the result is enclosed by the circle/curve

If you don't use a qualifier, FluidCAD returns **all** valid solutions. Use qualifiers to narrow it down to the one you want.

## The `mustTouch` option

`tArc()` and `tCircle()` accept an optional `mustTouch` boolean as their last argument. When `true`, only solutions that physically touch both objects are included:

```js
tArc(c1, c2, 50, true)        // only arcs that touch both c1 and c2
tCircle(l1, l2, 200, true)    // only circles that touch both lines
```

This is useful when the solver finds multiple valid tangent arcs or circles and you only want the ones that are in contact with both inputs.

## tLine

### Tangent continuation

The simplest use — draw a line that continues in the current tangent direction (shown by the orange arrow in the viewport):

```js
sketch("xy", () => {
    arc(50, 0, 90)
    tLine(100)                 // 100 units in the tangent direction
})
```

### Tangent to two objects

Draw a line tangent to two circles, arcs, or curves:

```js
import { outside, enclosing } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(100).guide()
    const c2 = circle([200, 0], 60).guide()

    tLine(outside(c1), outside(c2))       // tangent on the outside of both
})
```

Different qualifiers give different tangent lines:

```js
tLine(outside(c1), outside(c2))       // crosses between the circles
tLine(enclosing(c1), enclosing(c2))   // wraps around both circles
```

### Tangent between arcs

```js
sketch("xz", () => {
    move([-20, 0])
    const a1 = arc(100, 0, 180)
    move([50, -150])
    const a2 = arc(50, 270, 0)

    tLine(a1, a2)              // line tangent to both arcs
})
```

### Accessing tangent line endpoints

The result of a two-object `tLine()` exposes `.start()` and `.end()` vertices, which you can use to connect other geometry:

```js
const t1 = tLine(outside(c1), outside(c2))
const t2 = tLine(enclosing(c1), enclosing(c2))

// Connect the tangent lines with arcs
tArc(t1.end(), t2.end(), t1.tangent())
move(t1.start())
tArc(t2.start(), t1.start(), t1.tangent().reverse())
```

## tArc

`tArc()` is the most flexible constrained primitive. It can create arcs in several ways.

### Tangent continuation

Continue from the current position and tangent direction:

```js
sketch("front", () => {
    vLine(100)
    tArc(50, 180)              // radius 50, sweep 180°
    tArc(80, -270)             // radius 80, sweep -270° (clockwise)
})
```

Negative angles sweep clockwise, positive angles sweep counter-clockwise.

### Tangent to two objects

Draw an arc tangent to two circles, lines, arcs, or points:

```js
sketch("xy", () => {
    const c1 = circle(160).guide()
    const c2 = circle([200, 0], 60).guide()

    tArc(outside(c1), outside(c2), 80)     // radius 80, outside both
})
```

### Between a circle and a line

```js
sketch("xy", () => {
    const l = aLine(150, 45)
    const c = circle([100, 0], 40)

    tArc(c, l, 50).guide()    // radius 50, tangent to both
})
```

### Between two lines

```js
sketch("xy", () => {
    const l1 = aLine(150, 45)
    move([-50, 0])
    const l2 = vLine(100)

    tArc(l1, l2, 50).guide()  // fillet-like arc between two lines
})
```

### Through two points

```js
sketch("xy", () => {
    tArc([-50, 0], [50, 0], 150)   // arc through two points, radius 150
})
```

### From object to point

```js
sketch("xy", () => {
    const c = circle([100, 0], 40)
    const p = [100, 50]
    move(p)

    tArc(outside(c), p, 100)  // arc from circle to point, radius 100
})
```

## tCircle

`tCircle()` creates a full circle tangent to two objects. It takes the two objects and a diameter.

### Tangent to two circles

```js
import { outside, enclosing } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(160).guide()
    const c2 = circle([200, 0], 60).guide()

    tCircle(c1, enclosing(c2), 160).guide()    // tangent to c1, enclosing c2
    tCircle(outside(c1), outside(c2), 160).guide()  // outside both
})
```

### Tangent to two lines

```js
sketch("xy", () => {
    const l1 = aLine(300, 45)
    move([-50, 0])
    const l2 = vLine(300)

    tCircle(l1, l2, 200, true).guide()   // diameter 200, tangent to both lines
})
```

The fourth argument is [`mustTouch`](#the-musttouch-option) — when `true`, only solutions that touch both lines are returned.

### Between a circle and a line

```js
sketch("xy", () => {
    const l = aLine(150, 45)
    const c = circle([100, 0], 60)

    tCircle(c, l, 100).guide()
})
```

### Through two points

```js
sketch("xy", () => {
    tCircle([-50, 0], [50, 0], 300)    // diameter 300, through both points
})
```

## Common patterns

### Using guides for construction

Constrained geometry often works with `.guide()` shapes — construction circles and lines that define the tangent relationships but aren't part of the final profile:

```js
sketch("xy", () => {
    // Construction geometry
    const c1 = circle(100).guide()
    const c2 = circle([200, 0], 60).guide()

    // Actual profile built from tangent lines and arcs
    const t1 = tLine(outside(c1), outside(c2))
    const t2 = tLine(enclosing(c1), enclosing(c2))
    tArc(t1.end(), t2.end(), t1.tangent())
    move(t1.start())
    tArc(t2.start(), t1.start(), t1.tangent().reverse())
})

extrude(20)
```

### Smooth profiles with tangent chaining

Use `tArc()` after lines to create smooth transitions. The tangent direction carries forward automatically:

```js
sketch("front", () => {
    vLine(100)                 // straight up
    tArc(50, 180)              // smooth turn
    tArc(80, -270)             // another smooth turn
    tLine(50)                  // continue tangent
})
```

Each element starts where the previous one ended, and tangent arcs/lines maintain G1 continuity (no sharp corners).
