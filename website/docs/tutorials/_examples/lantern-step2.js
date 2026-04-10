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
    count: sides + 1,
    offset: 360 / sides
})
