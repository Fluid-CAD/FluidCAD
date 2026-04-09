---
sidebar_position: 3
title: "Compound Geometries"
---

# Compound Geometries

Compound geometries create complete, closed profiles in a single call. They are ready to extrude right away.

## rect

```js
sketch("xy", () => {
    rect(100, 60)              // 100 wide, 60 tall, starting at current position
    rect(80)                   // 80x80 square
    rect([10, 20], 50, 30)    // 50x30 rectangle starting at position [10, 20]
})
```

Useful methods on `rect`:

```js
rect(100, 60).center()         // center at the origin
rect(100, 60).radius(10)       // round the corners
rect(100, 60).center().radius(5)  // both
```

You can also access individual edges of a rect:

```js
const r = rect(100, 60)
r.topEdge()        // the top edge
r.bottomEdge()     // the bottom edge
r.leftEdge()       // the left edge
r.rightEdge()      // the right edge
```

## polygon

```js
sketch("xy", () => {
    polygon(6, 80)                  // hexagon with diameter 80
    polygon(5, 100, "inscribed")    // pentagon inscribed in a circle of diameter 100
})
```

## slot

An obround shape (rectangle with rounded ends):

```js
sketch("xy", () => {
    slot(100, 30)              // 100 long, 30 wide
    slot(80, 20).center()      // centered at origin
})
```

### Slot from edge

You can create a slot that follows an existing edge or arc. Pass the geometry as the first argument and the width as the second:

```js
sketch("xy", () => {
    move([100, 0])
    const a = arc(90, 0, 90)
    slot(a, 20, true)          // slot following the arc, width 20, remove the source arc
})

extrude(50)
```

The third argument (`true`) removes the source geometry after creating the slot. Set it to `false` to keep the original edge.
