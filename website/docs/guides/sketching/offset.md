---
sidebar_position: 6
title: "Offset"
---

# Offset

`offset()` creates a copy of sketch geometry shifted inward or outward by a given distance.

## Basic usage

Inside a sketch, `offset()` offsets all existing shapes:

```js
sketch("xy", () => {
    rect(50)
    offset(5)                  // offset all shapes outward by 5
})
```

Positive values offset outward, negative values offset inward.

## Removing the original

Pass `true` as the second argument to remove the original geometry and keep only the offset:

```js
sketch("xy", () => {
    rect(100, 60).center()
    offset(-10, true)          // shrink inward by 10, remove the original
})
```

## Combining with other shapes

Offset is useful for creating walls, margins, and clearances:

```js
sketch("xy", () => {
    rect(50)
    circle(30)
    offset(5)                  // both the rect and circle are offset
    circle(14)                 // add another shape after offsetting
})
```
