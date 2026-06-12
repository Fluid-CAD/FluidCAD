import { sketch, plane, text, move, select, wrap, cylinder } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(25, 60);
const target = select(face().cylinder());

const decal = sketch(plane("front", 25), () => {
    move([0, 24]);
    text("FLUID").size(12);
});

wrap(1, decal, target).remove();
