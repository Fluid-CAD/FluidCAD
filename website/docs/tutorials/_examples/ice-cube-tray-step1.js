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
