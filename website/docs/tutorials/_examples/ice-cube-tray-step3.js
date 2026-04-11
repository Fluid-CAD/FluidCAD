import { axis, circle, color, cut, extrude, fillet, fuse, hMove, loft, move, offset, plane, polygon, project, rect, repeat, revolve, select, shell, sketch, sphere, sweep, translate } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

const width = 300;
const length = 104;
const height = 50;
const leftOffset = 7;
const topOffset = 7;
const depth = 30;
const draft = 10;
const thickness = 2;

sketch("xy", () => {
    rect(width, length).center();
})

let e = extrude(height)

sketch(e.endFaces(), () => {
    move([-width/2 + leftOffset, -length/2 + topOffset])
    rect(30, 40)
});

let c = cut(depth).draft(-draft)

fillet(4, c.internalFaces())

repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [255, 50]
});
