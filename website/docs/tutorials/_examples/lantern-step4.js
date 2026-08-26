import {
    axis, circle, cut, extrude, line, loft, offset,
    plane, project, repeat, revolve, select, shell,
    sketch, sphere, translate
} from 'fluidcad/core';
import { coincident, equal } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';

const sides = 6;
const draft = 8;
const windowOffset = 6;
const wallThickness = 7;
const middleHeight = 150;

// A regular polygon of `sides` sides as solved lines: exact vertex guesses
// on the circumscribing circle (first vertex due east), coincident corners,
// and equal side lengths.
function ngon(diameter) {
    const r = diameter / 2;
    const points = [];
    for (let i = 0; i < sides; i++) {
        const a = (2 * Math.PI * i) / sides;
        points.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    const edges = points.map((p, i) => line(p, points[(i + 1) % sides]));
    for (let i = 0; i < sides; i++) {
        coincident(edges[i].end(), edges[(i + 1) % sides].start());
    }
    for (let i = 1; i < sides; i++) {
        equal(edges[0], edges[i]);
    }
    return edges;
}

// Middle Body
sketch(plane("xy", { offset: 24 }), () => {
    ngon(100);
})

const middle = extrude(middleHeight).draft(draft).new()

select(
    face().onPlane("xy", middleHeight + 24),
    face().onPlane("xy", 24),
);

shell(-wallThickness)

// Cut Windows
sketch(middle.sideFaces(0), () => {
    const outline = project(middle.sideFaces(0)).guide()
    offset(-windowOffset, outline)
})

const c = cut(7)

repeat("circular", "z", {
    count: sides,
    offset: 360 / sides
})

// Base
sketch("xy", () => {
    ngon(150);
});

const pl1 = extrude(12)

sketch(pl1.endFaces(), () => {
    ngon(115);
});

extrude(12)

// Top
const topPlane = plane("xy", { offset: middleHeight + 24 });
sketch(topPlane, () => {
    ngon(165);
});

const top = extrude(12)

sketch(plane(topPlane, { offset: 52 + 12 }), () => {
    ngon(50);
});

const tip = extrude(12)

loft(top.endFaces(), tip.startFaces())
