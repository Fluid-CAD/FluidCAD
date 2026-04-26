import {
    axis, circle, color, cut, extrude, loft, move, offset,
    plane, polygon, project, repeat, revolve, select, shell,
    sketch, sphere, translate
} from 'fluidcad/core';
import { face } from 'fluidcad/filters';

const sides = 6;
const draft = 8;
const windowOffset = 6;
const wallThickness = 7;
const middleHeight = 150;

// Middle Body
sketch(plane("xy", { offset: 24 }), () => {
    polygon(sides, 100);
})

const middle = extrude(middleHeight).draft(draft).new()

select(
    face().onPlane("xy", middleHeight + 24),
    face().onPlane("xy", 24),
);

shell(-wallThickness)

// Cut Windows
sketch(middle.sideFaces(0), () => {
    project(middle.sideFaces(0))
    offset(-windowOffset, true)
})

const c = cut(7)

repeat("circular", "z", {
    count: sides,
    offset: 360 / sides
})

// Base
polygon("xy", sides, 150);

const pl1 = extrude(12)

polygon(pl1.endFaces(), sides, 115);

extrude(12)

// Top
const topPlane = plane("xy", { offset: middleHeight + 24 });
polygon(topPlane, sides, 165);

const top = extrude(12)

polygon(plane(topPlane, { offset: 52 + 12 }), sides, 50);

const tip = extrude(12)

loft(top.endFaces(), tip.startFaces())

// Ring & Handle
let s = sphere(25 / 2)
translate([0, 0, 257], s)

const ringAxis = axis("y", { offsetZ: 290 })

sketch("yz", () => {
    circle([0, 290 + (65 / 2) - (7 / 2)], 7)
});
