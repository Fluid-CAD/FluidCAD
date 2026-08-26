import { sketch, plane, text, select, wrap, cylinder } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(25, 60);
const target = select(face().cylinder());

const decal = sketch(plane("front", 25), () => {
    text("FLUID").size(12).at([0, 24]);
});

wrap(1, decal, target);
