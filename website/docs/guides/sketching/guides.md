---
sidebar_position: 8
title: "Guides (Construction Geometry)"
---

# Guides (Construction Geometry)

Sometimes you need geometry in a sketch just for reference — to position other shapes, define tangent lines, or set up construction lines — without including it in the final profile. The `.guide()` method marks any sketch element as construction geometry.

## Making a guide

Call `.guide()` on any sketch shape:

```js
sketch("xy", () => {
    circle(100).guide()        // construction circle — won't be extruded
    polygon(6, 100)            // this hexagon is the actual profile
})

extrude(30)                    // only the hexagon is extruded
```

The guide circle helps you visually align the hexagon, but it's excluded from the final sketch output.

## Use cases

### Alignment reference

```js
sketch("xy", () => {
    circle(80).guide()         // reference circle for positioning

    move([40, 0])
    circle(15)                 // hole at 0°

    move([-40, 40])
    circle(15)                 // hole at 90°

    move([-40, -40])
    circle(15)                 // hole at 180°
})
```

### Construction lines

```js
sketch("xy", () => {
    line([0, 0], [100, 100]).guide()   // diagonal construction line
    rect(50, 30).center()              // actual geometry
})
```

Guide geometry is visible in the viewport but does not contribute to the extruded or cut profile.
